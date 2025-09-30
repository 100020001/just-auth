Vue.use( Toasted, {
    position: 'bottom-center'
} )

new Vue( {

    el: '#app',

    data: {
        user: '',
        domain: '@kihlstroms.se',
        pin: '',
        mailsent: false,
    },

    computed: {

        redirect() {
            const params = new URLSearchParams( window.location.search )
            return params.get( 'redirect' )
        },

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
                    body: JSON.stringify( { user, redirect: this.redirect } )
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
                    body: JSON.stringify( { user, pin } )
                } )
                const data = await response.json()

                if ( !data.error )
                {
                    this.$toasted.show( 'Authenticated. Redirecting...' )
                    setTimeout( () => {
                        window.location.href = `${data.success.redirect}?session=${data.success.token}`
                    }, 500 )
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

} )
