import { Hono } from 'hono'
const app = new Hono()
import { serveStatic } from 'hono/bun'
import { sign, verify } from 'hono/jwt'
import { Resend } from 'resend'
import path from 'path'


const authMap = new Map()

app.use( serveStatic( { root: path.resolve( process.cwd(), 'app' ) } ) )

app.post( '/login', async c => {

    const { user, redirect } = await c.req.json()
    const mail = user + '@kihlstroms.se'

    // Generate pin
    const pin = Math.floor( 1000 + Math.random() * 9000 ).toString()
    const payload = {
        mail,
        redirect,
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30, // 1 month in seconds
    }
    const token = await sign( payload, process.env.JWT_SECRET )

    // Store token and PIN by mail
    authMap.set( mail, { token, pin, redirect } )

    // Send mail with Resend
    try
    {
        const resend = new Resend( process.env.RESEND_API_KEY )
        await resend.emails.send( {
            from: 'no-reply@banarne.com',
            to: mail,
            subject: 'Your OTP Code',
            html: `<p>Your OTP code is: <b>${pin}</b></p>`
        } )
    }
    catch ( err )
    {
        return c.json( { error: 'Failed to send email' }, 500 )
    }

    return c.json( { success: `OTP code sent to ${mail}` } )
} )

app.post( '/verify-pin', async c => {

    const { user, pin } = await c.req.json()
    const mail = user + '@kihlstroms.se'

    const entry = authMap.get( mail )

    if ( !entry )
        return c.json( { error: 'No login attempt found' }, 400 )

    if ( entry.pin !== pin )
        return c.json( { error: 'Invalid PIN' }, 400 )

    // Verify token
    try
    {
        await verify( entry.token, process.env.JWT_SECRET )
    }
    catch ( e )
    {
        return c.json( { error: 'Token expired or invalid' }, 400 )
    }

    // On success
    return c.json( { success: entry } )
} )

export default app
