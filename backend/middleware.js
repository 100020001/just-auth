import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { verify } from 'hono/jwt'

const AUTH_URL = 'https://auth.justmorris.com'

export function createAuth( { secret, providerId, brandColor = 'blue', redirectAfterLogin = '/', exposeToken = false } ) {

    const isProduction = !!process.env.RAILWAY_STATIC_URL

    const cookieOpts = {
        path: '/',
        httpOnly: true,
        secure: isProduction,
        sameSite: 'Lax',
        maxAge: 60 * 60 * 24 * 30,
    }

    const verifyToken = token => verify( token, secret, 'HS256' )

    const getBaseUrl = c => {
        const proto = c.req.header( 'x-forwarded-proto' ) || 'http'
        const host = c.req.header( 'x-forwarded-host' ) || c.req.header( 'host' ) || 'localhost'
        return `${proto}://${host}`
    }

    const authUrl = c => {
        const callback = `${getBaseUrl( c )}/auth/callback`
        return `${AUTH_URL}?provider_id=${providerId}&brand_color=${brandColor}&redirect=${encodeURIComponent( callback )}`
    }

    // Routes: /auth/callback, /auth-check, /logout
    const routes = new Hono()

    routes.get( '/auth/callback', async c => {
        const token = c.req.query( 'session' )
        if ( token ) {
            try {
                await verifyToken( token )
                setCookie( c, 'session', token, cookieOpts )
            } catch {}
        }
        const url = new URL( c.req.url )
        url.searchParams.delete( 'session' )
        const params = url.searchParams.toString()
        return c.redirect( redirectAfterLogin + ( params ? '?' + params : '' ) )
    } )

    routes.get( '/auth-check', async c => {
        const token = getCookie( c, 'session' )
        if ( !token ) return c.json( { authenticated: false, redirectUrl: authUrl( c ) } )

        try {
            const user = await verifyToken( token )
            return c.json( { authenticated: true, user, ...( exposeToken ? { token } : {} ) } )
        } catch {
            setCookie( c, 'session', '', { ...cookieOpts, maxAge: 0 } )
            return c.json( { authenticated: false, redirectUrl: authUrl( c ) } )
        }
    } )

    routes.get( '/logout', c => {
        setCookie( c, 'session', '', { ...cookieOpts, maxAge: 0 } )
        return c.redirect( redirectAfterLogin )
    } )

    // Middleware: accepts ?session= token from cross-app navigation
    const sessionTransfer = async ( c, next ) => {
        const url = new URL( c.req.url )
        const token = url.searchParams.get( 'session' )
        if ( token && !c.req.path.startsWith( '/auth' ) ) {
            try {
                await verifyToken( token )
                setCookie( c, 'session', token, cookieOpts )
                url.searchParams.delete( 'session' )
                return c.redirect( url.pathname + url.search )
            } catch {}
        }
        return next()
    }

    // Middleware: requires valid session cookie
    const requireAuth = async ( c, next ) => {
        const token = getCookie( c, 'session' )
        if ( !token ) return c.json( { error: 'Unauthorized' }, 401 )
        try {
            await verifyToken( token )
            return next()
        } catch {
            return c.json( { error: 'Unauthorized' }, 401 )
        }
    }

    // Helper: get session token from cookie (for cross-app redirect endpoints)
    const getToken = c => getCookie( c, 'session' )

    return { routes, sessionTransfer, requireAuth, getToken, verifyToken, authUrl }
}
