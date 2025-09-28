import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { decode, sign, verify } from 'hono/jwt'
import path from 'path'

// In-memory store for tokens and PINs
const authMap = new Map()

const app = new Hono()

app.use( serveStatic( { root: path.resolve( process.cwd(), 'app' ) } ) )

app.post( '/login', async c => {

    const { mail, redirect } = await c.req.json()

    // Generate 4-digit PIN
    const pin = Math.floor( 1000 + Math.random() * 9000 ).toString()

    const payload = {
        mail,
        redirect,
        exp: Math.floor( Date.now() / 1000 ) + 60 * 10,
    }
    const secret = 'mySecretKey123'
    const token = await sign( payload, secret )

    // Store token and PIN by mail
    authMap.set( mail, { token, pin, redirect } )

    // TODO:Sned real mail
    console.log( `Send PIN ${pin} to mail: ${mail}` )

    // TODO: Dont send pin when live
    return c.json( { success: `Pin code sent!`, pin } )
} )

app.post( '/verify-pin', async c => {

    const { mail, pin } = await c.req.json()
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
