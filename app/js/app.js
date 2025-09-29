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

    methods: {

        async sendCode() {

            const user = this.user

            try
            {
                // Get the 'redirect' query param from the URL
                const params = new URLSearchParams( window.location.search )
                const redirect = params.get( 'redirect' )

                const response = await fetch( '/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify( { user, redirect } )
                } )

                const data = await response.json()

                if ( data.success )
                {
                    this.pin = data.pin

                    setTimeout( () => {
                        this.mailsent = true
                    }, 100 )

                    this.$toasted.show( data.success )
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
                    console.log( data.success )
                    const redirectUrl = `${data.success.redirect}?session=${data.success.token}`

                    this.$toasted.show( 'Authenticated...' )
                    this.$toasted.show( `Redirecting...` )

                    setTimeout( () => {
                        window.location.href = redirectUrl
                    }, 1000 )
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
        }
    },

} )
