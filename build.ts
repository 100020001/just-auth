import { rmSync, mkdirSync, readFileSync, writeFileSync, watch } from 'fs'
import { createHash } from 'crypto'

async function build() {
    rmSync('dist', { recursive: true, force: true })
    mkdirSync('dist/js', { recursive: true })
    mkdirSync('dist/css', { recursive: true })

    const result = await Bun.build({
        entrypoints: ['app/js/app.js'],
        outdir: 'dist/js',
        minify: true,
        naming: '[name]-[hash].[ext]',
        define: {
            '__VUE_OPTIONS_API__': 'false',
            '__VUE_PROD_DEVTOOLS__': 'false',
            '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false',
        },
    })

    if (!result.success || !result.outputs.length) {
        console.error('Build failed:', result.logs)
        process.exit(1)
    }

    const jsFilename = result.outputs[0].path.split('/').pop()!

    const css = readFileSync('app/css/style.css')
    const cssHash = createHash('md5').update(css).digest('hex').slice(0, 8)
    const cssFilename = `style-${cssHash}.css`
    writeFileSync(`dist/css/${cssFilename}`, css)

    const html = readFileSync('app/index.html', 'utf-8')
        .replace('/css/style.css', `/css/${cssFilename}`)
        .replace('<script src="/js/app.js"></script>', `<script src="/js/${jsFilename}"></script>`)

    writeFileSync('dist/index.html', html)

    console.log(`Built: /js/${jsFilename}, /css/${cssFilename}`)
}

await build()

if (process.argv.includes('--watch')) {
    let timeout: Timer | null = null
    for (const dir of ['app/js', 'app/css', 'app']) {
        watch(dir, () => {
            if (timeout) clearTimeout(timeout)
            timeout = setTimeout(() => build().catch(console.error), 100)
        })
    }
    console.log('Watching app/ for changes...')
}
