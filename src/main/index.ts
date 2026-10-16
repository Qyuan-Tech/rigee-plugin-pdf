import { readFile, stat } from 'node:fs/promises'
import type { Context, Plugin } from 'cordis'
import { registerPdfCommands } from '../protocol'

/**
 * The PDF viewer, main half: one bounded file read, and nothing else.
 *
 * PDFJS-DIST MUST NEVER BE IMPORTED HERE. The build would bundle it into dist/main.js, and Rigee
 * would parse all of pdf.js in its main process the first time this half is asked for a file — for
 * a library that only ever runs in the window. The renderer half loads it, on demand.
 *
 * `inject` is not optional: reading `ctx.commands` without declaring it throws "cannot get property
 * … without inject", and a half whose injection cannot be satisfied does not fail loudly — its
 * fiber sits in PENDING forever and `apply` never runs.
 */

/**
 * Above this we refuse rather than try.
 *
 * Much larger than the text editor's MAX_EDITABLE_BYTES (8 MB) because a PDF is read once into an
 * array pdf.js immediately transfers into its worker, not into a Monaco model with an undo stack —
 * but still a cap, because the read, the structured clone and the worker copy all have to fit in
 * memory at once. 256 MB is past every book, scan and standards document anyone has produced.
 */
const MAX_PDF_BYTES = 256 * 1024 * 1024

const plugin: Plugin = {
  name: 'pdf',
  inject: ['commands'],
  apply(ctx: Context) {
    // Captured once, at activation, and BOUND. cordis substitutes the shadow context — the thing
    // that makes `this.ctx.pluginId` mean "pdf" — only when the method is called with the service
    // proxy as its receiver, so a bare `const register = ctx.commands.register` arrives with
    // `this === undefined` and throws at the first call rather than at capture.
    const commands = ctx.commands
    const register = commands.register.bind(commands)

    registerPdfCommands(register, {
      'pdf:read': async ({ path }) => {
        // NEVER readFileSync. The main process is single-threaded and shared: a synchronous 50 MB
        // read stalls every terminal's pty pump, every git call and every browser tab for its
        // whole duration. MEASURED end to end through the bridge: ~200 ms for 50 MB, of which
        // 25-43 ms is the disk read; a typical 1-10 MB PDF lands in under 30 ms.
        const { size } = await stat(path)
        if (size > MAX_PDF_BYTES) {
          throw new Error(
            `${path} is ${mib(size)} MiB, past the ${mib(MAX_PDF_BYTES)} MiB limit for PDFs`
          )
        }
        const buffer = await readFile(path)

        // An explicit copy, and it is load-bearing. MEASURED HAZARD: node hands small reads out of
        // a shared 64 KiB allocation pool, and the structured clone that carries a Buffer to the
        // renderer clones its ENTIRE backing store — a 4-byte Buffer arrived as a Uint8Array(4)
        // whose .buffer.byteLength was 65536, carrying whatever other Buffers happened to share
        // the pool. That is both waste and a cross-boundary information leak.
        return { bytes: new Uint8Array(buffer), size }
      }
    })
  }
}

export default plugin

function mib(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}
