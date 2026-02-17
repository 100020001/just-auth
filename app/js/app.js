import { createApp, ref, computed, watch, nextTick, onMounted } from 'vue/dist/vue.esm-bundler.js'
import QRCode from 'qrcode'

// Lightweight i18n - true if Swedish
const sv = navigator.language?.startsWith( 'sv' )

document.title = sv ? 'Verifiera din e-post' : 'Verify Your Email'

const app = createApp( {

    setup() {

        const email = ref( '' )
        watch( email, ( v ) => email.value = v.toLowerCase() )
        const settings = ref( {} )
        const pin = ref( '' )
        const mailsent = ref( false )
        const provider_id = ref( '' )
        const redirect = ref( '' )
        const brand_color = ref( 'neutral' )

        const pinInput = ref( null )
        const myButton1 = ref( null )
        const myButton2 = ref( null )

        // QR login state
        const qrState = ref( 'loading' )    // loading | ready | scanned | authenticated | expired
        const qrSessionId = ref( '' )
        const qrDataUrl = ref( '' )
        const qrExpiryTimer = ref( null )
        const qrPollTimer = ref( null )
        const isQrSession = ref( false )
        const qrMobileComplete = ref( false )
        const qrPollErrors = ref( 0 )
        const qrGeneration = ref( 0 )

        // Computed
        const validDomains = computed( () => settings.value.mailDomains || [] )

        const emailDomain = computed( () => {
            const parts = email.value.split( '@' )
            return parts.length === 2 ? parts[ 1 ] : ''
        } )

        const isValidEmail = computed( () => {
            if ( !email.value || !validDomains.value.length ) return false
            const parts = email.value.split( '@' )
            return parts.length === 2 && parts[ 0 ].length > 0 && validDomains.value.includes( parts[ 1 ] )
        } )

        const user = computed( () => email.value.split( '@' )[ 0 ] || '' )

        // Toast
        function toast( message ) {
            const el = document.createElement( 'div' )
            el.className = 'toast wa-dark'
            el.textContent = message
            document.body.appendChild( el )
            setTimeout( () => {
                el.classList.add( 'fade-out' )
                el.addEventListener( 'animationend', () => el.remove() )
            }, 4800 )
        }

        const choices = ref( null )
        const pendingRedirect = ref( null )

        function redirectWithToken( url, token ) {
            try {
                const redirectUrl = new URL( url )
                redirectUrl.searchParams.set( 'session', token )
                window.location.href = redirectUrl.toString()
            } catch {
                toast( sv ? 'Ogiltig omdirigerings-URL' : 'Invalid redirect URL' )
            }
        }

        async function submitChoice( value ) {
            const param = choices.value.param
            choices.value = null
            if ( isQrSession.value ) {
                const res = await fetch( `/qr/choose/${qrSessionId.value}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify( { param, value } )
                } ).catch( () => null )
                if ( res?.ok ) qrMobileComplete.value = true
            } else {
                const url = new URL( pendingRedirect.value.redirect )
                url.searchParams.set( param, value )
                redirectWithToken( url.toString(), pendingRedirect.value.token )
            }
        }

        // Watch
        watch( mailsent, ( newVal ) => {
            if ( newVal ) {
                nextTick( () => pinInput.value?.focus() )
                clearTimeout( qrExpiryTimer.value )
                clearTimeout( qrPollTimer.value )
            }
        } )

        // Methods
        async function sendCode() {
            try
            {
                const response = await fetch( '/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify( {
                        user: user.value,
                        provider_domain: emailDomain.value,
                        provider_id: provider_id.value,
                        redirect: redirect.value,
                        lang: sv ? 'sv' : 'en',
                    } )
                } )

                const data = await response.json()

                if ( data.success )
                {
                    toast( data.success )
                    mailsent.value = true
                }
                else if ( data.error )
                {
                    toast( data.error )
                }
            }
            catch ( err )
            {
                toast( err.message )
            }
        }

        async function verifyCode() {
            try
            {
                const response = await fetch( '/verify-pin', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify( {
                        user: user.value,
                        pin: pin.value,
                        provider_id: provider_id.value,
                        provider_domain: emailDomain.value,
                        lang: sv ? 'sv' : 'en',
                        ...( isQrSession.value && { qr_session: qrSessionId.value } ),
                    } )
                } )

                const data = await response.json()

                if ( !data.error )
                {
                    if ( data.success?.choose )
                    {
                        choices.value = data.success.choose
                        if ( data.success.token ) pendingRedirect.value = { token: data.success.token, redirect: data.success.redirect }
                    }
                    else if ( data.success?.qr_completed )
                    {
                        qrMobileComplete.value = true
                    }
                    else
                    {
                        toast( sv ? 'Autentiserad. Omdirigerar...' : 'Authenticated. Redirecting...' )
                        redirectWithToken( data.success.redirect, data.success.token )
                    }
                }
                else
                {
                    toast( data.error )
                }
            }
            catch ( err )
            {
                toast( err.message )
            }
        }

        // QR Methods
        async function createQrSession() {
            qrState.value = 'loading'
            const gen = ++qrGeneration.value
            try {
                const res = await fetch( '/qr/create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify( {
                        provider_id: provider_id.value,
                        redirect: redirect.value,
                    } )
                } )
                if ( gen !== qrGeneration.value ) return
                const data = await res.json()
                if ( data.error ) {
                    qrState.value = 'expired'
                    return
                }

                qrSessionId.value = data.session_id

                const qrUrl = `${window.location.origin}/?provider_id=${provider_id.value}`
                    + `&redirect=${encodeURIComponent( redirect.value )}`
                    + `&brand_color=${brand_color.value}`
                    + `&qr_session=${data.session_id}`

                qrDataUrl.value = await QRCode.toDataURL( qrUrl, {
                    width: 160,
                    margin: 2,
                    color: { dark: '#000000', light: '#ffffff' }
                } )

                qrState.value = 'ready'
                qrPollErrors.value = 0

                qrExpiryTimer.value = setTimeout( () => {
                    if ( qrState.value === 'ready' || qrState.value === 'scanned' ) {
                        qrState.value = 'expired'
                        clearTimeout( qrPollTimer.value )
                    }
                }, data.ttl_ms )

                qrPollTimer.value = setTimeout( pollQrStatus, 5000 )
            }
            catch ( err ) {
                console.warn( 'QR create error:', err.message )
                qrState.value = 'expired'
            }
        }

        async function pollQrStatus() {
            const gen = qrGeneration.value
            if ( qrState.value !== 'ready' && qrState.value !== 'scanned' ) return

            try {
                const res = await fetch( `/qr/status/${qrSessionId.value}` )
                if ( gen !== qrGeneration.value ) return
                const data = await res.json()
                qrPollErrors.value = 0

                if ( data.status === 'scanned' && qrState.value === 'ready' ) {
                    qrState.value = 'scanned'
                }
                else if ( data.status === 'authenticated' ) {
                    qrState.value = 'authenticated'
                    clearTimeout( qrExpiryTimer.value )
                    toast( sv ? 'Autentiserad. Omdirigerar...' : 'Authenticated. Redirecting...' )
                    setTimeout( () => redirectWithToken( data.redirect, data.token ), 1500 )
                    return
                }
                else if ( data.status === 'expired' ) {
                    qrState.value = 'expired'
                    return
                }
            }
            catch ( err ) {
                qrPollErrors.value++
                console.warn( 'QR poll error:', err.message )
                if ( qrPollErrors.value >= 5 ) {
                    qrState.value = 'expired'
                    return
                }
            }

            if ( gen !== qrGeneration.value ) return
            qrPollTimer.value = setTimeout( pollQrStatus, 5000 )
        }

        function refreshQr() {
            clearTimeout( qrExpiryTimer.value )
            clearTimeout( qrPollTimer.value )
            createQrSession()
        }

        // Mounted
        onMounted( async () => {
            const params = new URLSearchParams( window.location.search )
            redirect.value = params.get( 'redirect' ) || ''
            provider_id.value = params.get( 'provider_id' ) || ''
            brand_color.value = ( params.get( 'brand_color' ) || 'neutral' ).replace( /[^a-z0-9-]/gi, '' )

            const styleElement = document.createElement( 'style' )
            styleElement.textContent = `:root {
                --wa-color-brand-20: var(--wa-color-${brand_color.value}-20);
                --wa-color-brand-90: var(--wa-color-${brand_color.value}-90);
                --wa-color-text-link: var(--wa-color-${brand_color.value}-50);
                --wa-color-focus: var(--wa-color-${brand_color.value}-50);
            }`
            document.head.appendChild( styleElement )

            try {
                const res = await fetch( '/settings' + ( provider_id.value ? `/${provider_id.value}` : '' ) )
                settings.value = await res.json()
            } catch {
                document.body.textContent = sv ? 'Kunde inte ladda inställningar. Uppdatera sidan.' : 'Failed to load settings. Please refresh.'
                return
            }

            if ( settings.value.error ) {
                document.body.textContent = settings.value.error
                return
            }

            // QR session detection
            const qrSessionParam = params.get( 'qr_session' )
            if ( qrSessionParam ) {
                isQrSession.value = true
                qrSessionId.value = qrSessionParam
                fetch( `/qr/scanned/${qrSessionParam}`, { method: 'POST' } ).catch( () => {} )
            }
            else if ( redirect.value && provider_id.value && window.innerWidth > 600 ) {
                createQrSession()
            }

            window.addEventListener( 'beforeunload', () => {
                clearTimeout( qrExpiryTimer.value )
                clearTimeout( qrPollTimer.value )
            } )
        } )

        return {
            email,
            settings,
            pin,
            mailsent,
            isValidEmail,
            pinInput,
            myButton1,
            myButton2,
            sendCode,
            verifyCode,
            sv,
            qrState,
            qrDataUrl,
            isQrSession,
            qrMobileComplete,
            choices,
            refreshQr,
            submitChoice,
        }
    }

} )

app.mount( '#app' )
