/**
 * What the PDF viewer's two halves say to each other.
 *
 * One command, in one direction, and no events: a PDF is a file that does not change while you
 * read it. Everything else the viewer does — parsing, rendering, text extraction, the outline —
 * happens in the renderer, inside pdf.js's own worker, and never crosses this boundary.
 *
 * REALM-FREE. Compiled into both the node project and the web project, so no node:*, no DOM, no
 * JSX. Types, and the two wrappers at the bottom that keep either half from spelling the command
 * name as a bare string.
 */

/**
 * A whole PDF, read off disk.
 *
 * `size` is carried separately because pdf.js TRANSFERS `bytes` into its worker and detaches the
 * array — measured: `byteLength` 0 and `buffer.detached` true the moment `getDocument` is called.
 * Anything the UI wants to say about the file's size has to be remembered before that.
 */
export interface PdfFile {
  bytes: Uint8Array
  size: number
}

export interface PdfCommands {
  /** Read the whole file. Rejects for a missing file or one past the size cap. */
  'pdf:read': (args: { path: string }) => PdfFile
}

export type PdfCommand = keyof PdfCommands
export type PdfArgs<K extends PdfCommand> = Parameters<PdfCommands[K]>[0]
export type PdfResult<K extends PdfCommand> = Awaited<ReturnType<PdfCommands[K]>>

/** One typed call. What the renderer half uses instead of `invoke('pdf:read', …)`. */
export type PdfCall = <K extends PdfCommand>(command: K, args: PdfArgs<K>) => Promise<PdfResult<K>>

/** Wrap the host's untyped `invoke` in the command map, so a typo is a compile error. */
export function pdfClient(invoke: (command: string, args: unknown) => Promise<unknown>): PdfCall {
  return (command, args) => invoke(command, args) as never
}

/**
 * Every handler the main half must provide, derived from the command map — so adding a command
 * here fails the build in main until it is answered.
 */
export type PdfHandlers = {
  [K in PdfCommand]: (args: PdfArgs<K>) => PdfResult<K> | Promise<PdfResult<K>>
}

export function registerPdfCommands(
  register: (name: string, handler: (payload: unknown) => unknown) => void,
  handlers: PdfHandlers
): void {
  for (const [name, handler] of Object.entries(handlers)) {
    register(name, handler as (payload: unknown) => unknown)
  }
}
