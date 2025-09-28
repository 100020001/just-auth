import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { sign, verify } from 'hono/jwt'
import path from 'path'
const app = new Hono()

const secret = 'mySecretKey123'
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
        exp: Math.floor( Date.now() / 1000 ) + 60 * 10,
    }
    const token = await sign( payload, secret )

    // Store token and PIN by mail
    authMap.set( mail, { token, pin, redirect } )

    // TODO:Sned real mail
    console.log( `Send PIN to mail: ${mail}` )

    // TODO: Dont send pin when live
    return c.json( { success: `OTP code sent to ${mail}`, pin } )
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
        const secret = 'mySecretKey123'
        await verify( entry.token, secret )
    }
    catch ( e )
    {
        return c.json( { error: 'Token expired or invalid' }, 400 )
    }

    // On success
    return c.json( { success: entry } )
} )

export default app
