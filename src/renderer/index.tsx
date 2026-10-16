import { liveTabIds, subscribeTabs } from '@rigee/plugin-api'
import { closeAllDocuments, scheduleSweep } from './documents'
import { PdfView } from './PdfView'
import { setPdfjsAssets } from './pdfjs'
import { connect } from './rpc'
import type { Context, Plugin } from 'cordis'

// This module is dist/renderer.js, so its own URL is the one fixed point in the build's layout.
setPdfjsAssets(new URL('./pdfjs/', import.meta.url))

/**
 * The PDF viewer's renderer half.
 *
 * Three effects, and every one of them exists to make a failure impossible rather than unlikely:
 *
 *   - `connect` parks the typed RPC client the components use. Captured ONCE here, and BOUND:
 *     cordis substitutes the shadow context only when a service method is called with the service
 *     proxy as its receiver, so a bare `const invoke = ctx.rpc.invoke` handed to a component that
 *     calls it as a plain function arrives with `this === undefined` and throws on `this.ctx`.
 *     Measured per call: 17.7 us through the context, 4.5 us through a held service, 0.22 us bound.
 *   - the tab subscription is how a parsed document learns that its tab has gone. It is the only
 *     thing standing between "open a few PDFs" and a leaked pdf.js worker, with its wasm heaps,
 *     per file.
 *   - the last effect's disposer tears every document down, so unloading the plugin leaves nothing
 *     running. Nothing here has to remember to clean up; the fiber does it.
 *
 * `inject` is mandatory and `apply` must have a braced body: reading `ctx.contributions` without
 * declaring it throws, a half whose injection cannot be satisfied sits in PENDING forever instead
 * of failing, and cordis reads a plugin's RETURN VALUE as an effect — so the tempting
 * `apply: (ctx) => ctx.contributions.editor(...)` throws `TypeError: Invalid effect`.
 */
const plugin: Plugin = {
  name: 'pdf',
  inject: ['contributions', 'rpc'],
  apply(ctx: Context) {
    const rpc = ctx.rpc
    const invoke = rpc.invoke.bind(rpc)

    ctx.effect(() => connect(invoke), 'pdf rpc')
    ctx.effect(() => subscribeTabs(scheduleSweep), 'document lifetimes')
    ctx.effect(() => () => { void closeAllDocuments() }, 'documents')

    ctx.contributions.editor('pdf.preview', PdfView)

    // A tab may already have been closed while this plugin was loading — the reader clicked a PDF
    // and changed their mind — so the first sweep runs now rather than waiting for the next change.
    scheduleSweep(liveTabIds())
  }
}

export default plugin
