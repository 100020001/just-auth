import { Hono, Context, Next } from 'hono'
import { serveStatic } from 'hono/bun'
import { sign, verify } from 'hono/jwt'
import { Resend } from 'resend'
import { randomInt } from 'crypto'
import path from 'path'

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
    PIN_VERIFY: { maxAttempts: 5, windowMs: 15 * 60 * 1000 }  // 5 attempts per 15 minutes
} as const

const TOKEN_EXPIRY_SECONDS = 60 * 60 * 24 * 30  // 30 days
const PIN_EXPIRY_MS = 10 * 60 * 1000            // 10 minutes
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
    fromAddress: string
): Promise<{ success: boolean; error?: string }> {
    const resend = new Resend(process.env.RESEND_API_KEY)

    const result = await resend.emails.send({
        from: fromAddress,
        to: toEmail,
        subject: 'Your Verification Code',
        html: `Your verification code is<br><h1>${pin}</h1>`
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
app.use(serveStatic({ root: path.resolve(process.cwd(), 'app') }))

/**
 * GET /settings/:provider_id
 * Returns public provider settings (excludes secret).
 */
app.get('/settings/:provider_id?', loadProviderConfig, async (c: AppContext) => {
    const { secret, ...publicConfig } = c.get('providerConfig')
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
    const { user, redirect: redirectUrl, provider_domain: domain } = body as {
        user: string
        redirect: string
        provider_domain: string
    }

    // Validate domain is allowed for this provider
    if (!config.mailDomains.includes(domain)) {
        return c.json({ error: 'Invalid email domain' }, 400)
    }

    const email = buildEmail(user, domain)

    // Check rate limit
    const { maxAttempts, windowMs } = RATE_LIMITS.LOGIN
    if (!isRateLimitAllowed(loginRateLimits, email, maxAttempts, windowMs)) {
        return c.json({ error: 'Too many login attempts. Try again later.' }, 429)
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
    const emailResult = await sendVerificationEmail(email, pin, config.sendAddress)

    if (!emailResult.success) {
        return c.json({ error: emailResult.error || 'Failed to send email' }, 500)
    }

    return c.json({ success: `Verification code sent to ${email}` })
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
    const { user, pin, provider_domain: domain } = body as {
        user: string
        pin: string
        provider_domain: string
    }

    // Validate domain
    if (!config.mailDomains.includes(domain)) {
        return c.json({ error: 'Invalid email domain' }, 400)
    }

    const email = buildEmail(user, domain)

    // Check rate limit - invalidate session if exceeded
    const { maxAttempts, windowMs } = RATE_LIMITS.PIN_VERIFY
    if (!isRateLimitAllowed(pinVerifyRateLimits, email, maxAttempts, windowMs)) {
        pendingAuthSessions.delete(email)
        return c.json({ error: 'Too many attempts. Please request a new code.' }, 429)
    }

    // Look up pending session
    const session = pendingAuthSessions.get(email)

    if (!session) {
        return c.json({ error: 'No pending login found. Please start again.' }, 400)
    }

    // Check if PIN has expired
    if (session.expiresAt < Date.now()) {
        pendingAuthSessions.delete(email)
        return c.json({ error: 'Code expired. Please request a new one.' }, 400)
    }

    // Validate PIN
    if (session.pin !== pin) {
        return c.json({ error: 'Invalid code' }, 400)
    }

    // Verify token is still valid
    try {
        await verify(session.token, config.secret)
    } catch {
        pendingAuthSessions.delete(email)
        return c.json({ error: 'Session expired. Please start again.' }, 400)
    }

    // Success - cleanup and return token
    pendingAuthSessions.delete(email)
    pinVerifyRateLimits.delete(email)

    return c.json({
        success: {
            token: session.token,
            redirect: session.redirectUrl
        }
    })
})

export default app
