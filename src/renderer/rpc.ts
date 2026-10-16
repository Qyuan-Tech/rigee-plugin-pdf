import { pdfClient, type PdfCall } from '../protocol'

/**
 * The plugin's own line to main, reachable from a component.
 *
 * Components cannot hold `ctx`: a cordis service access rebuilds a shadow context on every
 * property read — 15 us against 8 ns for a plain call. So the renderer entry captures
 * `ctx.rpc.invoke` ONCE at activation and parks the typed client here.
 *
 * Parked through `ctx.effect`, so disposing the plugin unparks it and a viewer that somehow
 * outlives its plugin gets a clear error rather than a call into a dead fiber.
 */
let live: PdfCall | null = null

export function connect(invoke: (command: string, args: unknown) => Promise<unknown>): () => void {
  live = pdfClient(invoke)
  return () => { live = null }
}

export const pdf: PdfCall = (command, args) => {
  if (!live) return Promise.reject(new Error(`the PDF viewer is not active, cannot ${command}`))
  return live(command, args)
}
