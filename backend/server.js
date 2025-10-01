import { Hono } from 'hono'
const app = new Hono()
import { serveStatic } from 'hono/bun'
import { sign, verify } from 'hono/jwt'
import { Resend } from 'resend'
import path from 'path'


const authMap = new Map()

app.use( serveStatic( { root: path.resolve( process.cwd(), 'app' ) } ) )


app.get( '/settings/:provider_id', async c => {

    let { provider_id } = c.req.param()
    provider_id = provider_id.toUpperCase()

    let settings = { error: 'Invalid domain' }

    if ( process.env[ `CONFIG_${provider_id}` ] )
    {
        const parsed = JSON.parse( process.env[ `CONFIG_${provider_id}` ] )

        // Remove 'secret' key using object rest syntax
        const { secret, ...rest } = parsed
        settings = { ...rest }
    }

    return c.json( settings )
} )


app.post( '/login', async c => {

    let { provider_id, user, redirect } = await c.req.json()
    provider_id = provider_id.toUpperCase()

    let settings
    if ( !process.env[ `CONFIG_${provider_id}` ] )
        return c.json( { error: 'Invalid domain' }, 400 )
    else
        settings = JSON.parse( process.env[ `CONFIG_${provider_id}` ] )

    const sanitizedUser = user.replace( /[^a-zA-Z0-9._-]/g, '' )
    const mail = sanitizedUser + '@' + settings.mailDomain

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
            from: 'no-reply@api.kihlstroms.se',
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

app.post( '/verify-pin', async c => {

    let { provider_id, user, pin } = await c.req.json()
    provider_id = provider_id.toUpperCase()

    let settings
    if ( !process.env[ `CONFIG_${provider_id}` ] )
        return c.json( { error: 'Invalid domain' }, 400 )
    else
        settings = JSON.parse( process.env[ `CONFIG_${provider_id}` ] )

    const mail = user + '@' + settings.mailDomain
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
