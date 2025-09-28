Vue.use( Toasted, {
    position: 'bottom-center'
} )

new Vue( {
    el: '#app',

    data: {
        user: 'andre',
        domain: '@kihlstroms.se',
        pin: '',
        mailsent: false,
    },

    methods: {

        async sendCode() {

            const mail = this.user + this.domain

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
                    body: JSON.stringify( { mail, redirect } )
                } )

                const data = await response.json()

                if ( data.success )
                {
                    this.mailsent = true
                    this.$toasted.show( data.success )
                }
            }
            catch ( err )
            {
                this.$toasted.show( err.message )
            }
        },

        async verifyCode() {

            const mail = this.user + this.domain
            const pin = this.pin

            try
            {
                const response = await fetch( '/verify-pin', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify( { mail, pin } )
                } )
                const data = await response.json()

                if ( !data.error )
                {
                    console.log( data.success )

                    this.$toasted.show( 'Authenticated' )
                    this.$toasted.show( `Redirecting... ${data.success.redirect}?session=${data.success.token}` )

                    // setTimeout(() => {
                    //     window.location.href = data.success.redirect
                    // }, 2000)
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
        }

    }
} )
