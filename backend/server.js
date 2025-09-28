import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { decode, sign, verify } from 'hono/jwt'
import path from 'path'

const app = new Hono()


app.use( serveStatic( { root: path.resolve( process.cwd(), 'app' ) } ) )


app.post( '/login', async c => {

    const { email } = await c.req.json()


    const payload = {
        user: email,
        exp: Math.floor( Date.now() / 1000 ) + 60 * 10,
    }
    const secret = 'mySecretKey123'
    const token = await sign( payload, secret )

    console.log( token )


    // For now, just return success
    return c.json( { success: true } )
} )

export default app
