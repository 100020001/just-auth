import { Hono, Context, Next } from 'hono'
import { serveStatic } from 'hono/bun'
import { sign, verify } from 'hono/jwt'
import { Resend } from 'resend'
import { randomInt, randomBytes, timingSafeEqual } from 'crypto'

const resend = new Resend(process.env.RESEND_API_KEY)

// ============================================================================
// Types
// ============================================================================

/** Pending authentication session stored while awaiting PIN verification */
interface PendingAuth {
    token: string
    pin: string
    redirectUrl: string
    expiresAt: number
}

/** Provider configuration loaded from environment variables */
interface ProviderConfig {
    secret: string
    mailDomains: string[]
    sendAddress: string
    redirectDomains?: string[]
}

/** QR login session stored while awaiting mobile authentication */
interface QrSession {
    providerId: string
    redirectUrl: string
    status: 'pending' | 'scanned' | 'awaiting_choice' | 'authenticated'
    token?: string
    expiresAt: number
}

/** Rate limit tracking entry */
interface RateLimitEntry {
    attempts: number
    windowExpiresAt: number
}

/** Hono context variables for type safety */
type AppVariables = {
    providerConfig: ProviderConfig
    requestBody: Record<string, unknown>
}

type AppContext = Context<{ Variables: AppVariables }>

// ============================================================================
// Constants
// ============================================================================

const RATE_LIMITS = {
    LOGIN: { maxAttempts: 5, windowMs: 60 * 1000 },           // 5 attempts per minute
    PIN_VERIFY: { maxAttempts: 5, windowMs: 15 * 60 * 1000 }, // 5 attempts per 15 minutes
    QR_CREATE: { maxAttempts: 10, windowMs: 60 * 1000 },      // 10 per minute
} as const

const TOKEN_EXPIRY_SECONDS = 60 * 60 * 24 * 30  // 30 days
const PIN_EXPIRY_MS = 10 * 60 * 1000            // 10 minutes
const QR_SESSION_EXPIRY_MS = 5 * 60 * 1000     // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000           // 1 minute

// ============================================================================
// In-Memory Storage
// ============================================================================

/** Maps email -> pending auth session */
const pendingAuthSessions = new Map<string, PendingAuth>()

/** Maps email -> login rate limit tracking */
const loginRateLimits = new Map<string, RateLimitEntry>()

/** Maps email -> PIN verification rate limit tracking */
const pinVerifyRateLimits = new Map<string, RateLimitEntry>()

/** Maps provider_id -> QR create rate limit tracking */
const qrCreateRateLimits = new Map<string, RateLimitEntry>()

/** Maps sessionId -> QR login session */
const qrSessions = new Map<string, QrSession>()

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Removes expired entries from all in-memory stores.
 * Runs periodically to prevent memory leaks.
 */
function cleanupExpiredEntries(): void {
    const now = Date.now()

    for (const [email, session] of pendingAuthSessions) {
        if (session.expiresAt < now) {
            pendingAuthSessions.delete(email)
        }
    }

    for (const [email, limit] of loginRateLimits) {
        if (limit.windowExpiresAt < now) {
            loginRateLimits.delete(email)
        }
    }

    for (const [email, limit] of pinVerifyRateLimits) {
        if (limit.windowExpiresAt < now) {
            pinVerifyRateLimits.delete(email)
        }
    }

    for (const [id, session] of qrSessions) {
        if (session.expiresAt < now) {
            qrSessions.delete(id)
        }
    }

    for (const [key, limit] of qrCreateRateLimits) {
        if (limit.windowExpiresAt < now) {
            qrCreateRateLimits.delete(key)
        }
    }
}

setInterval(cleanupExpiredEntries, CLEANUP_INTERVAL_MS)

/**
 * Checks if an action is allowed under rate limiting rules.
 * Increments the attempt counter if allowed.
 *
 * @param store - The rate limit map to check against
 * @param key - Unique identifier (usually email)
 * @param maxAttempts - Maximum allowed attempts in the window
 * @param windowMs - Time window in milliseconds
 * @returns true if action is allowed, false if rate limited
 */
function isRateLimitAllowed(
    store: Map<string, RateLimitEntry>,
    key: string,
    maxAttempts: number,
    windowMs: number
): boolean {
    const now = Date.now()
    const entry = store.get(key)

    // First attempt or window expired - reset counter
    if (!entry || entry.windowExpiresAt < now) {
        store.set(key, { attempts: 1, windowExpiresAt: now + windowMs })
        return true
    }

    // Already at limit
    if (entry.attempts >= maxAttempts) {
        return false
    }

    entry.attempts++
    return true
}

/**
 * Extracts username from email input and removes invalid characters.
 * Handles both "user" and "user@domain.com" formats.
 *
 * @param input - Raw user input (username or full email)
 * @returns Sanitized username containing only alphanumeric, dots, underscores, hyphens
 */
function sanitizeUsername(input: string): string {
    const username = input.split('@')[0]
    return username.replace(/[^a-zA-Z0-9._-]/g, '')
}

/**
 * Builds a full email address from sanitized username and domain.
 */
function buildEmail(username: string, domain: string): string {
    return `${sanitizeUsername(username)}@${domain}`
}

/**
 * Generates a cryptographically secure 6-digit PIN.
 */
function generateSecurePin(): string {
    return randomInt(100000, 1000000).toString()
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function secureCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/**
 * Validates redirect URL is HTTPS (or localhost for development).
 */
function isValidRedirectUrl(url: string, allowedDomains?: string[]): boolean {
    try {
        const parsed = new URL(url)
        const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
        if (parsed.protocol !== 'https:' && !isLocalhost) return false
        return !allowedDomains?.length || allowedDomains.includes(parsed.hostname)
    } catch {
        return false
    }
}

/**
 * Safely parses JSON request body.
 * Returns null if parsing fails.
 */
async function parseJsonBody<T>(c: AppContext): Promise<T | null> {
    try {
        return await c.req.json()
    } catch {
        return null
    }
}

// ============================================================================
// Middleware
// ============================================================================

/**
 * Middleware that loads provider configuration from environment variables.
 * Extracts provider_id from URL param or request body.
 * Sets providerConfig in context for downstream handlers.
 */
async function loadProviderConfig(c: AppContext, next: Next) {
    // Parse body once and store in context for reuse
    const body = await parseJsonBody<Record<string, unknown>>(c) || {}
    c.set('requestBody', body)

    // Try URL param first, then request body
    const providerId = c.req.param('provider_id') || (body.provider_id as string)

    if (!providerId) {
        return c.json({ error: 'Missing provider_id' }, 400)
    }

    // Load config from environment (e.g., CONFIG_ACME for provider "acme")
    const envKey = `CONFIG_${providerId.toUpperCase()}`
    const rawConfig = process.env[envKey]

    if (!rawConfig) {
        return c.json({ error: 'Unknown provider' }, 404)
    }

    try {
        const config = JSON.parse(rawConfig) as ProviderConfig

        if (!config || typeof config !== 'object' || Array.isArray(config)) {
            throw new Error('Invalid config format')
        }

        c.set('providerConfig', config)
        return next()
    } catch (err) {
        console.error(`Failed to parse config for ${providerId}:`, err)
        return c.json({ error: 'Invalid provider configuration' }, 500)
    }
}

// ============================================================================
// Email Service
// ============================================================================

/**
 * Sends verification PIN to user's email address.
 *
 * @returns Object with success boolean and optional error message
 */
async function sendVerificationEmail(
    toEmail: string,
    pin: string,
    fromAddress: string,
    sv: boolean
): Promise<{ success: boolean; error?: string }> {
    const result = await resend.emails.send({
        from: fromAddress,
        to: toEmail,
        subject: sv ? `${pin} — Din verifieringskod` : `${pin} — Your Verification Code`,
        html: `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:400px;margin:0 auto;padding:40px 20px;text-align:center">
            <p style="color:#666;font-size:15px;margin:0 0 24px">${sv ? 'Din verifieringskod är' : 'Your verification code is'}</p>
            <p style="font-size:36px;font-weight:700;letter-spacing:8px;margin:0;padding:16px 0">${pin}</p>
            <p style="color:#999;font-size:13px;margin:24px 0 0">${sv ? 'Koden är giltig i 10 minuter.' : 'This code expires in 10 minutes.'}</p>
        </div>`
    })

    if (result.error) {
        return { success: false, error: result.error.message }
    }

    return { success: true }
}

// ============================================================================
// App Setup & Routes
// ============================================================================

const app = new Hono<{ Variables: AppVariables }>()

// Serve static files from /app directory
app.use('/*', serveStatic({ root: './dist' }))

/**
 * GET /settings/:provider_id
 * Returns public provider settings (excludes secret).
 */
app.get('/settings/:provider_id?', loadProviderConfig, async (c: AppContext) => {
    const { secret: _, ...publicConfig } = c.get('providerConfig')
    return c.json(publicConfig)
})

/**
 * POST /login
 * Initiates email-based authentication.
 * Generates a PIN, stores pending session, and emails the PIN to user.
 *
 * Request body: { provider_id, user, provider_domain, redirect }
 * Response: { success: string } or { error: string }
 */
app.post('/login', loadProviderConfig, async (c: AppContext) => {
    const config = c.get('providerConfig')
    const body = c.get('requestBody')
    const { user, redirect: redirectUrl, provider_domain: domain, lang } = body as {
        user: string
        redirect: string
        provider_domain: string
        lang?: string
    }
    const sv = lang === 'sv'

    // Validate required fields
    if (!user || !domain || !redirectUrl) {
        return c.json({ error: sv ? 'Obligatoriska fält saknas' : 'Missing required fields' }, 400)
    }

    // Validate redirect URL
    if (!isValidRedirectUrl(redirectUrl, config.redirectDomains)) {
        return c.json({ error: sv ? 'Ogiltig omdirigerings-URL' : 'Invalid redirect URL' }, 400)
    }

    // Validate domain is allowed for this provider
    if (!config.mailDomains.includes(domain)) {
        return c.json({ error: sv ? 'Ogiltig e-postdomän' : 'Invalid email domain' }, 400)
    }

    const email = buildEmail(user, domain)

    // Check rate limit
    const { maxAttempts, windowMs } = RATE_LIMITS.LOGIN
    if (!isRateLimitAllowed(loginRateLimits, email, maxAttempts, windowMs)) {
        return c.json({ error: sv ? 'För många inloggningsförsök. Försök igen senare.' : 'Too many login attempts. Try again later.' }, 429)
    }

    // Generate PIN and JWT token
    const pin = generateSecurePin()
    const tokenPayload = {
        mail: email,
        exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_SECONDS
    }
    const token = await sign(tokenPayload, config.secret)

    // Store pending session
    pendingAuthSessions.set(email, {
        token,
        pin,
        redirectUrl,
        expiresAt: Date.now() + PIN_EXPIRY_MS
    })

    // Send verification email
    const emailResult = await sendVerificationEmail(email, pin, config.sendAddress, sv)

    if (!emailResult.success) {
        return c.json({ error: emailResult.error || (sv ? 'Kunde inte skicka e-post' : 'Failed to send email') }, 500)
    }

    return c.json({ success: sv ? `Verifieringskod skickad till ${email}` : `Verification code sent to ${email}` })
})

/**
 * POST /verify-pin
 * Validates PIN and returns JWT token on success.
 *
 * Request body: { provider_id, user, provider_domain, pin }
 * Response: { token: string, redirect: string } or { error: string }
 */
app.post('/verify-pin', loadProviderConfig, async (c: AppContext) => {
    const config = c.get('providerConfig')
    const body = c.get('requestBody')
    const { user, pin, provider_domain: domain, lang } = body as {
        user: string
        pin: string
        provider_domain: string
        lang?: string
    }
    const sv = lang === 'sv'

    // Validate required fields
    if (!user || !domain || !pin) {
        return c.json({ error: sv ? 'Obligatoriska fält saknas' : 'Missing required fields' }, 400)
    }

    // Validate domain
    if (!config.mailDomains.includes(domain)) {
        return c.json({ error: sv ? 'Ogiltig e-postdomän' : 'Invalid email domain' }, 400)
    }

    const email = buildEmail(user, domain)

    // Check rate limit - invalidate session if exceeded
    const { maxAttempts, windowMs } = RATE_LIMITS.PIN_VERIFY
    if (!isRateLimitAllowed(pinVerifyRateLimits, email, maxAttempts, windowMs)) {
        pendingAuthSessions.delete(email)
        return c.json({ error: sv ? 'För många försök. Begär en ny kod.' : 'Too many attempts. Please request a new code.' }, 429)
    }

    // Look up pending session
    const session = pendingAuthSessions.get(email)

    if (!session) {
        return c.json({ error: sv ? 'Ingen väntande inloggning hittades. Börja om.' : 'No pending login found. Please start again.' }, 400)
    }

    // Check if PIN has expired
    if (session.expiresAt < Date.now()) {
        pendingAuthSessions.delete(email)
        return c.json({ error: sv ? 'Koden har gått ut. Begär en ny.' : 'Code expired. Please request a new one.' }, 400)
    }

    // Validate PIN (constant-time comparison)
    if (!secureCompare(session.pin, pin)) {
        return c.json({ error: sv ? 'Ogiltig kod' : 'Invalid code' }, 400)
    }

    // Verify token is still valid
    try {
        await verify(session.token, config.secret, 'HS256')
    } catch {
        pendingAuthSessions.delete(email)
        return c.json({ error: sv ? 'Sessionen har gått ut. Börja om.' : 'Session expired. Please start again.' }, 400)
    }

    // QR flow: validate QR session before consuming the pending auth
    const qrSessionId = body.qr_session as string
    const qrSession = qrSessionId ? qrSessions.get(qrSessionId) : undefined
    if (qrSessionId) {
        if (!qrSession || qrSession.expiresAt < Date.now()) {
            return c.json({ error: sv ? 'QR-sessionen har gått ut. Försök igen.' : 'QR session expired. Please try again.' }, 400)
        }
        if (qrSession.providerId !== (body.provider_id as string)) {
            return c.json({ error: sv ? 'Ogiltig QR-session' : 'Invalid QR session' }, 400)
        }
        if (qrSession.status !== 'scanned') {
            return c.json({ error: sv ? 'Ogiltig QR-sessionsstatus' : 'Invalid QR session state' }, 400)
        }
    }

    // Success - cleanup and return token
    pendingAuthSessions.delete(email)
    pinVerifyRateLimits.delete(email)

    if (qrSession) {
        qrSession.token = session.token
        const { secret: _, ...publicConfig } = config
        if ((publicConfig as any).choices) {
            qrSession.status = 'awaiting_choice'
            return c.json({ success: { choose: (publicConfig as any).choices } })
        }
        qrSession.status = 'authenticated'
        return c.json({ success: { qr_completed: true } })
    }

    const { secret: _, ...publicConfig } = config
    return c.json({
        success: {
            token: session.token,
            redirect: session.redirectUrl,
            ...((publicConfig as any).choices && { choose: (publicConfig as any).choices })
        }
    })
})

// ============================================================================
// QR Code Login Flow
// ============================================================================

/**
 * POST /qr/create
 * Creates a new QR login session for a device without a keyboard.
 *
 * Request body: { provider_id, redirect }
 * Response: { session_id, expires_at } or { error: string }
 */
app.post('/qr/create', loadProviderConfig, async (c: AppContext) => {
    const body = c.get('requestBody')
    const { redirect: redirectUrl, provider_id: providerId } = body as { redirect: string; provider_id: string }

    if (!redirectUrl) {
        return c.json({ error: 'Missing redirect URL' }, 400)
    }

    if (!isValidRedirectUrl(redirectUrl, c.get('providerConfig').redirectDomains)) {
        return c.json({ error: 'Invalid redirect URL' }, 400)
    }

    const { maxAttempts, windowMs } = RATE_LIMITS.QR_CREATE
    if (!isRateLimitAllowed(qrCreateRateLimits, providerId, maxAttempts, windowMs)) {
        return c.json({ error: 'Too many requests. Try again later.' }, 429)
    }

    const sessionId = randomBytes(32).toString('hex')

    qrSessions.set(sessionId, {
        providerId,
        redirectUrl,
        status: 'pending',
        expiresAt: Date.now() + QR_SESSION_EXPIRY_MS
    })

    return c.json({
        session_id: sessionId,
        ttl_ms: QR_SESSION_EXPIRY_MS
    }, 201)
})

/**
 * GET /qr/status/:session_id
 * Polled by the original device to check if auth completed.
 * Returns token on success and deletes the session (one-time retrieval).
 */
app.get('/qr/status/:session_id', async (c) => {
    const sessionId = c.req.param('session_id')
    const session = qrSessions.get(sessionId)

    if (!session || session.expiresAt < Date.now()) {
        if (session) qrSessions.delete(sessionId)
        return c.json({ status: 'expired' }, 404)
    }

    if (session.status === 'authenticated' && session.token) {
        const { token, redirectUrl } = session
        qrSessions.delete(sessionId)
        return c.json({ status: 'authenticated', token, redirect: redirectUrl })
    }

    return c.json({ status: session.status })
})

/**
 * POST /qr/scanned/:session_id
 * Called by the mobile device when it opens the QR URL.
 * Transitions session from pending to scanned.
 */
app.post('/qr/scanned/:session_id', async (c) => {
    const sessionId = c.req.param('session_id')
    const session = qrSessions.get(sessionId)

    if (!session || session.expiresAt < Date.now()) {
        return c.json({ error: 'Session not found or expired' }, 404)
    }

    if (session.status === 'pending') {
        session.status = 'scanned'
    }

    return c.json({ status: session.status })
})

/**
 * POST /qr/choose/:session_id
 * Called by mobile device after PIN verification to submit a choice (e.g. driftställe).
 * Appends the choice as a query param to the redirect URL and marks session as authenticated.
 */
app.post('/qr/choose/:session_id', async (c) => {
    const sessionId = c.req.param('session_id')
    const session = qrSessions.get(sessionId)

    if (!session || session.expiresAt < Date.now()) {
        return c.json({ error: 'Session not found or expired' }, 404)
    }
    if (session.status !== 'awaiting_choice') {
        return c.json({ error: 'Invalid session state' }, 400)
    }

    const body = await c.req.json().catch(() => null)
    if (!body?.param || !body?.value) {
        return c.json({ error: 'Missing param or value' }, 400)
    }

    const url = new URL(session.redirectUrl)
    url.searchParams.set(body.param, body.value)
    session.redirectUrl = url.toString()
    session.status = 'authenticated'

    return c.json({ success: true })
})

export default app
