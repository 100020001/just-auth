Vue.use( Toasted, {
    position: 'bottom-right',
    duration: null,
} )

new Vue( {
    el: '#app',

    data: {
        user: 'andre',
        domain: '@kihlstroms.se'
    },

    methods: {

        async sendLoginCode() {

            const email = this.user + this.domain
            try
            {
                const response = await fetch( '/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify( { email } )
                } )

                if ( !response.ok )
                    throw new Error( 'Failed to send login code' )

                this.$toasted.show( 'Login code sent!' )

            }
            catch ( err )
            {
                this.$toasted.show( 'Error: ' + err.message )
            }
        }

    }
} )
