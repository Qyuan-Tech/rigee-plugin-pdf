/**
 * pdf.js, loaded once, configured once, for the one plugin that needs it.
 *
 * PDF.JS IS NOT BUNDLED. Its own minified build ships in dist/pdfjs/ exactly as pdf.js published
 * it — byte for byte, so anyone can check it against the upstream release — and is imported from
 * there by URL the first time a document is actually loaded, rather than when the plugin is.
 *
 * Everything pdf.js fetches for itself ships beside it: the worker, the CMaps, the standard fonts,
 * the colour profiles and three WebAssembly decoders, all copied by scripts/build.mjs and served
 * from Rigee's plugin scheme like the rest of the plugin. `pdfjs-dist` is a dependency for its
 * types, and for those files.
 */

import { workerUrl } from '@rigee/plugin-api'

type Pdfjs = typeof import('pdfjs-dist')

/** dist/pdfjs/, as a URL. Set by the entry module, the one file whose own URL is known. */
let assets: URL | null = null

/**
 * Where pdf.js's files are. Called once, by renderer/index.tsx with
 * `new URL('./pdfjs/', import.meta.url)`: the entry is always dist/renderer.js, whereas this module
 * may be bundled into a chunk under dist/chunks/, where its own `import.meta.url` would point the
 * worker one directory too deep.
 */
export function setPdfjsAssets(url: URL): void {
  assets = url
}

let apiP: Promise<Pdfjs> | null = null

export function loadPdfjs(): Promise<Pdfjs> {
  apiP ??= (async () => {
    const pdfjs = (await import(/* @vite-ignore */ asset('pdf.min.mjs'))) as Pdfjs

    /*
     * A worker URL, NOT a `workerPort`, and not a bundler's worker import (which forces you onto
     * workerPort). VERIFIED IN THE SOURCE, pdf.mjs:16390-16398: PDFWorker.create caches one
     * PDFWorker per port in a WeakMap, so two open PDF tabs would share a single worker and the
     * first tab's `loadingTask.destroy()` would break the second; and with a port `#webWorker` is
     * null, so destroy() never calls terminate() and every document opened leaks a 1.2 MB worker
     * plus its wasm heaps. With `workerSrc`, getDocument creates a dedicated worker per document
     * and destroy() terminates it.
     *
     * Through `workerUrl`, because the window may not start a worker from the plugin's own URL —
     * Rigee starts it from its own origin and has it import ours. That also means the worker gets
     * no Content Security Policy of its own, which is why WASM compiles inside it even though the
     * window forbids it. All 13 WebAssembly references live in pdf.worker.mjs; none in pdf.mjs.
     */
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl(asset('pdf.worker.min.mjs'))
    return pdfjs
  })()
  return apiP
}

/**
 * The runtime assets the worker fetches for itself.
 *
 * EVERY URL NEEDS ITS TRAILING SLASH: `getFactoryUrlProp` throws
 * `Invalid factory url: "…" must include trailing slash.` otherwise, and it throws at
 * getDocument() time, which reads as "this PDF is broken".
 *
 * `cMapUrl` is what makes CJK work. Any CIDFont using a predefined Adobe CMap — UniGB-UCS2-H,
 * GBK-EUC-H, ETen-B5-H, the Adobe-GB1-* and Adobe-CNS1-* families — renders blank or garbled
 * without it, and the only symptom is a warn() inside the worker that nobody sees.
 *
 * `useWorkerFetch` is explicit on purpose. pdf.js auto-detects it with `/https?:/.test(protocol)`,
 * which is true under Rigee's dev server and false in a packaged file:// renderer — two different
 * code paths for the same build — and false ADDITIONALLY hard-disables ICC colour management
 * (pdf.worker.mjs:2775-2778). The worker fetches from `rigee-plugin://` itself, which the scheme's
 * CORS answer permits.
 */
export function assetOptions(): {
  cMapUrl: string
  cMapPacked: boolean
  standardFontDataUrl: string
  wasmUrl: string
  iccUrl: string
  useWorkerFetch: boolean
} {
  return {
    cMapUrl: asset('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts/'),
    wasmUrl: asset('wasm/'),
    iccUrl: asset('iccs/'),
    useWorkerFetch: true
  }
}

/**
 * A file under dist/pdfjs/: `rigee-plugin://pdf/@<build>/dist/pdfjs/…`. The worker fetches these
 * itself, across origins, which Rigee's plugin scheme allows.
 */
function asset(rel: string): string {
  if (!assets) throw new Error('pdf.js assets were asked for before the plugin said where they are')
  return new URL(rel, assets).href
}
