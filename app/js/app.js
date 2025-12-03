const { createApp, ref, computed, watch, nextTick, onMounted } = Vue

// Lightweight i18n - true if Swedish
const sv = navigator.language?.startsWith( 'sv' )

document.title = sv ? 'Verifiera din e-post' : 'Verify Your Email'

const app = createApp( {

    setup() {

        const email = ref( '' )
        const settings = ref( {} )
        const pin = ref( '' )
        const mailsent = ref( false )
        const provider_id = ref( '' )
        const redirect = ref( '' )
        const brand_color = ref( 'neutral' )

        const pinInput = ref( null )
        const myButton1 = ref( null )
        const myButton2 = ref( null )

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
            setTimeout( () => el.remove(), 5000 )
        }

        // Watch
        watch( mailsent, ( newVal ) => {
            if ( newVal )
            {
                nextTick( () => pinInput.value?.focus() )
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
                    } )
                } )

                const data = await response.json()

                if ( !data.error )
                {
                    toast( sv ? 'Autentiserad. Omdirigerar...' : 'Authenticated. Redirecting...' )
                    const redirectUrl = new URL( data.success.redirect )
                    redirectUrl.searchParams.set( 'session', data.success.token )
                    window.location.href = redirectUrl.toString()
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

            const res = await fetch( '/settings' + ( provider_id.value ? `/${provider_id.value}` : '' ) )
            settings.value = await res.json()

            if ( settings.value.error )
                document.body.innerHTML = settings.value.error
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
        }
    }

} )

app.mount( '#app' )
