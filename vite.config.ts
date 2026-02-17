import { defineConfig } from 'vite'

export default defineConfig({
    root: 'app',
    build: {
        outDir: '../dist',
        emptyOutDir: true,
    },
    define: {
        __VUE_OPTIONS_API__: false,
        __VUE_PROD_DEVTOOLS__: false,
        __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
    },
    server: {
        proxy: {
            '/login': 'http://localhost:66',
            '/verify-pin': 'http://localhost:66',
            '/settings': 'http://localhost:66',
            '/qr': 'http://localhost:66',
        },
    },
})
