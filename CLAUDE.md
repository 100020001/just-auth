# just-auth - Passwordless Email OTP Authentication Service

## Overview
Shared authentication service for multiple apps. Users verify via email OTP (6-digit PIN). Supports QR login for cross-device auth. Hosted at auth.justmorris.com.

## Tech Stack
- **Runtime**: Bun + Hono
- **Frontend**: Vue 3 (CDN build), Vite, Open Props CSS
- **Email**: Resend API
- **JWT**: hono/jwt (HS256, provider-specific secrets)
- **Deploy**: Railway

## Directory Structure
```
app/
├── js/app.js          # Vue 3 frontend (setup API)
├── index.html         # Login page template
└── css/style.css      # Styles (Open Props based)
backend/
└── server.ts          # Hono API (all endpoints)
dist/                  # Vite build output
vite.config.ts         # Build config
```

## Provider Configuration
Providers are configured via environment variables: `CONFIG_<PROVIDER_ID>` (JSON).

```json
{
  "friendlyName": "Display Name",
  "mailDomains": ["company.com"],
  "sendAddress": "no-reply@company.com",
  "secret": "<jwt-signing-secret>",
  "redirectDomains": ["app.company.com", "localhost"],
  "choices": { "param": "key", "label": "Choose", "options": [...] }
}
```

### mailDomains Security Model
- `["company.com"]` — Only `@company.com` emails accepted. Backend enforces via `validateAuth()`.
- `["*"]` — Any email domain accepted (e.g. mygishop lets any email login, then checks DB for access).
- **Wildcard does NOT compromise restricted providers.** If kihlstroms has `["kihlstroms.se"]`:
  - An attacker sending `provider_domain: "*"` is rejected — `"*"` is not in `["kihlstroms.se"]`
  - An attacker sending `provider_domain: "gmail.com"` is rejected — same reason
  - The `includes('*')` check only passes when `"*"` is explicitly in the provider's own config
- **Cross-provider isolation**: Tokens are signed with provider-specific secrets. A mygishop token cannot be verified by kihlstroms.
- **Session isolation**: `pendingAuthSessions` are keyed by `provider_id:email` to prevent cross-provider collisions.
- **Domain sanitization**: `sanitizeDomain()` strips control characters, validates format, prevents injection.
- **Redirect protection**: `redirectDomains` config restricts which hosts can receive the JWT token callback.

## Endpoints
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/settings/:provider_id` | GET | Public config (excludes secret) |
| `/login` | POST | Send OTP PIN to email |
| `/verify-pin` | POST | Verify PIN, return JWT |
| `/qr/create` | POST | Create QR login session |
| `/qr/status/:id` | GET | Poll QR session status |
| `/qr/scanned/:id` | POST | Mark QR as scanned (mobile) |
| `/qr/choose/:id` | POST | Submit choice for QR session |

## i18n
Two languages: English (default) and Swedish. Detected via `navigator.language`. The `lang` param (`'sv'` or `'en'`) is sent to backend for email/error translations.

## Development
```bash
bun run dev   # Vite dev server + backend
```
Port configured via `PORT` env var (default 66 locally).

## Key Security Notes
- JWT secrets are per-provider — never shared
- PINs are 6-digit, cryptographically random, expire in 10 minutes
- PIN comparison uses constant-time `timingSafeEqual`
- Rate limits: 5 login attempts/min per email, 5 PIN attempts/15min per email
- Cookies are NOT used — tokens passed via redirect URL `?session=` param
- Frontend validation is UX only — backend `validateAuth()` is the security gate
