Vue.use( Toasted, {
    position: 'bottom-center',
    duration: 5000,
} )

new Vue( {

    el: '#app',

    data: {
        user: '',
        selectedDomain: '',
        settings: {},
        pin: '',
        mailsent: false,
        provider_id: '',
        redirect: '',
        brand_color: 'neutral',
    },

    computed: {

        redirectDomain() {

            if ( !this.redirect ) return ''

            try
            {
                const url = new URL( this.redirect )
                return url.hostname
            }
            catch ( e )
            {
                return ''
            }
        }
    },

    watch: {

        mailsent( newVal ) {
            if ( newVal )
            {
                this.$nextTick( () => {
                    if ( this.$refs.pinInput )
                    {
                        this.$refs.pinInput.focus()
                    }
                } )
            }
        },

    },

    methods: {

        cleanUser() {

            this.user = this.user.split( '@' )[ 0 ]
        },

        async sendCode() {

            const user = this.user

            try
            {
                const response = await fetch( '/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify( {
                        user,
                        provider_domain: this.selectedDomain,
                        provider_id: this.provider_id,
                        redirect: this.redirect,
                    } )
                } )

                const data = await response.json()

                if ( data.success )
                {
                    this.$toasted.show( data.success )
                    this.mailsent = true
                }
                else if ( data.error )
                {
                    this.$toasted.show( data.error )
                }
            }
            catch ( err )
            {
                this.$toasted.show( err.message )
            }
        },

        async verifyCode() {

            const user = this.user
            const pin = this.pin

            try
            {
                const response = await fetch( '/verify-pin', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify( {
                        user,
                        pin,
                        provider_id: this.provider_id,
                        provider_domain: this.selectedDomain,
                    } )
                } )
                const data = await response.json()

                if ( !data.error )
                {
                    this.$toasted.show( 'Authenticated. Redirecting...' )
                    const redirectUrl = new URL( data.success.redirect )
                    redirectUrl.searchParams.set( 'session', data.success.token )
                    window.location.href = redirectUrl.toString()
                }
                else
                {
                    this.$toasted.show( data.error )
                }
            }
            catch ( err )
            {
                this.$toasted.show( err.message )
            }
        },

    },

    async mounted() {

        const params = new URLSearchParams( window.location.search )
        this.redirect = params.get( 'redirect' ) || ''
        this.provider_id = params.get( 'provider_id' ) || ''
        this.brand_color = ( params.get( 'brand_color' ) || 'neutral' ).replace( /[^a-z0-9-]/gi, '' )

        // Apply brand color
        const styleElement = document.createElement( 'style' )
        styleElement.textContent = `:root {
            --wa-color-brand-20: var(--wa-color-${this.brand_color}-20);
            --wa-color-brand-90: var(--wa-color-${this.brand_color}-90);
            --wa-color-text-link: var(--wa-color-${this.brand_color}-50);
            --wa-color-focus: var(--wa-color-${this.brand_color}-50);
        }`
        document.head.appendChild( styleElement )

        // Get settings for domain
        const settings = await fetch( '/settings' + ( this.provider_id ? `/${this.provider_id}` : '' ) )
        this.settings = await settings.json()

        if ( this.settings.error )
            return document.body.innerHTML = this.settings.error

        // Select first domain as default
        this.selectedDomain = this.settings.mailDomains?.[ 0 ] || ''
    },

} )
