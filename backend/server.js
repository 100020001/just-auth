import { Hono } from 'hono'
const app = new Hono()
import { serveStatic } from 'hono/bun'
import { sign, verify } from 'hono/jwt'
import { Resend } from 'resend'
import path from 'path'


const authMap = new Map()

app.use( serveStatic( { root: path.resolve( process.cwd(), 'app' ) } ) )


// Helper function to get provider settings or return error response
async function getProviderSettings( c, next ) {

    let provider_id
    const paramId = c.req.param( 'provider_id' )

    if ( paramId )
    {
        provider_id = paramId.toUpperCase()
    }
    else
    {
        // For POST routes without URL param, parse body
        try
        {
            const body = await c.req.json()
            provider_id = body.provider_id.toUpperCase()
        }
        catch ( err )
        {
            return c.json( { error: 'Missing provider_id' }, 404 )
        }
    }

    const config = process.env[ `CONFIG_${provider_id}` ]
    if ( !config )
        return c.json( { error: 'Invalid provider_id' }, 400 )

    let settings
    try
    {
        settings = JSON.parse( config )
        if ( !settings || typeof settings !== 'object' || Array.isArray( settings ) )
        {
            throw new Error( 'Parsed config is not a valid object' )
        }
    }
    catch ( parseErr )
    {
        console.error( `JSON parse error for ${provider_id}:`, parseErr )
        return c.json( { error: 'Invalid configuration' }, 500 )
    }

    if ( settings )
    {
        c.set( 'providerSettings', settings )
        return next()
    }
    else
    {
        return c.json( { error: 'Provider settings not found x' }, 404 )
    }
}


app.get( '/settings/:provider_id?', getProviderSettings, async c => {

    const settings = c.get( 'providerSettings' )
    const { secret, ...safe_settings } = settings // Remove 'secret' key

    return c.json( safe_settings )
} )


app.post( '/login', getProviderSettings, async c => {

    const settings = c.get( 'providerSettings' )
    const { user, redirect, provider_domain } = await c.req.json()

    if ( !settings.mailDomains.includes( provider_domain ) )
        return c.json( { error: 'Invalid domain' }, 400 )

    const sanitizedUser = user.split( '@' )[ 0 ].replace( /[^a-zA-Z0-9._-]/g, '' )
    const mail = sanitizedUser + '@' + provider_domain

    // Generate pin
    const pin = Math.floor( 1000 + Math.random() * 9000 ).toString()
    const payload = {
        mail,
        redirect,
        exp: Math.floor( Date.now() / 1000 ) + 60 * 60 * 24 * 30, // 1 month in seconds
    }
    const token = await sign( payload, settings.secret )

    // Store token and PIN by mail
    authMap.set( mail, { token, pin, redirect } )

    // Send mail with Resend
    try
    {
        const resend = new Resend( process.env.RESEND_API_KEY )
        const result = await resend.emails.send( {
            from: settings.sendAddress,
            to: mail,
            subject: 'Your Pin Code',
            html: `<p>Your Pin code is: <b>${pin}</b></p>`
        } )

        if ( result.error )
            return c.json( { error: result.error.message }, result.error.statusCode )
        else
            return c.json( { success: `Pin code sent to ${mail}` } )
    }
    catch ( err )
    {
        return c.json( { error: 'Failed to send email' }, 500 )
    }

} )

app.post( '/verify-pin', getProviderSettings, async c => {

    const settings = c.get( 'providerSettings' )
    const { user, pin, provider_domain } = await c.req.json()

    if ( !settings.mailDomains.includes( provider_domain ) )
        return c.json( { error: 'Invalid domain' }, 400 )

    const mail = user + '@' + provider_domain
    const entry = authMap.get( mail )

    if ( !entry )
        return c.json( { error: 'No login attempt found' }, 400 )

    if ( entry.pin !== pin )
        return c.json( { error: 'Invalid PIN' }, 400 )

    // Verify token
    try
    {
        await verify( entry.token, settings.secret )
    }
    catch ( e )
    {
        return c.json( { error: 'Token expired or invalid' }, 400 )
    }

    // On success
    return c.json( { success: entry } )
} )


export default app
