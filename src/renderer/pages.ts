import type { RenderQueue } from './queue'
import type {
  PageViewport,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
  TextLayer
} from 'pdfjs-dist'

/**
 * The continuous page column: virtualisation, canvases, text layers and zoom.
 *
 * Imperative, and deliberately so. React owns the scroll container and nothing inside it — the
 * same split as the Monaco editor pane, for the same reason: canvases, render tasks and text
 * layers are long-lived, expensive and cancellable, and putting any of that in component state
 * would re-render a 500-page column on every scroll tick.
 *
 * THE FOUR THINGS THAT MAKE THIS SURVIVE A REAL DOCUMENT
 *
 *  1. Placeholders are sized from page 1 and corrected when a page is realised. Asking the worker
 *     for 500 viewports at open costs 500 round-trips before anything paints; almost every PDF is
 *     uniform, and the ones that are not settle as you scroll past them.
 *  2. Everything is laid out from ONE CSS variable, `--pdf-scale`. Page boxes, canvases and text
 *     layers all derive their size from it, so a zoom step is a single style write plus a scroll
 *     correction — no per-page JS, no relayout loop — and the re-render at the new resolution is
 *     debounced behind it.
 *  3. One render task per page, cancelled before it is replaced. pdf.js keeps a static WeakSet of
 *     canvases with a render in flight and throws "Cannot use the same canvas during multiple
 *     render() operations." A cancelled task's promise REJECTS with a RenderingCancelledException,
 *     which is not an error and must not be reported as one.
 *  4. Teardown in a fixed order. `page.cleanup()` returns false — silently — while a render task
 *     is outstanding, so cancelling first is what actually frees the operator list and the decoded
 *     images; and the canvas must be resized to 0x0 before it is dropped or Chromium keeps the
 *     backing store alive until GC gets round to it.
 */

type Pdfjs = typeof import('pdfjs-dist')

/** pdf.js's own ceilings, from its `maxCanvasPixels` / `maxCanvasDim` defaults. */
const MAX_CANVAS_PIXELS = 2 ** 25
const MAX_CANVAS_DIM = 32767

/** Long enough that a wheel-driven zoom re-renders once, short enough to feel immediate. */
const RESCALE_DEBOUNCE = 150

/** Must match the column's horizontal padding in pdf.css, or "fit width" clips. */
const PAGE_MARGIN = 16

interface Slot {
  n: number
  el: HTMLElement
  canvas: HTMLCanvasElement | null
  textEl: HTMLElement | null
  hitsEl: HTMLElement | null
  page: PDFPageProxy | null
  task: RenderTask | null
  text: TextLayer | null
  textRendered: boolean
  /**
   * Bumped by every realise and every unrealise.
   *
   * React StrictMode double-invokes effects and a scroll can reverse between two awaits, so every
   * async step re-checks this before touching the DOM. Without it a page that scrolled off screen
   * mid-render gets its canvas painted into after it was dropped.
   */
  gen: number
  /** The scale currently on the canvas; 0 when it is empty. */
  painted: number
  /** Whether the box has been corrected from this page's own dimensions. */
  sized: boolean
}

export interface PageListOptions {
  pdfjs: Pdfjs
  doc: PDFDocumentProxy
  /** The scrolling element. The column is appended to it and the observers use it as their root. */
  container: HTMLElement
  /** Shared with the thumbnail rail, which is how thumbnails stay strictly lower priority. */
  queue: RenderQueue
  scale: number
  /** The topmost page actually on screen changed. */
  onPage: (n: number) => void
  /** A page's canvas and text layer are ready, so anything overlaying them can be drawn. */
  onRealized: (n: number) => void
}

export async function createPageList(options: PageListOptions): Promise<PageList> {
  // One page, before anything is built: every placeholder is sized from it.
  const first = await options.doc.getPage(1)
  return new PageList(options, first)
}

export class PageList {
  private readonly pdfjs: Pdfjs
  private readonly doc: PDFDocumentProxy
  private readonly container: HTMLElement
  private readonly onPage: (n: number) => void
  private readonly onRealized: (n: number) => void

  private readonly column = document.createElement('div')
  private readonly slots: Slot[] = []
  private readonly queue: RenderQueue
  private readonly onScreen = new Set<number>()
  /** Page 1's unscaled width, which is what "fit width" is computed against. */
  private readonly unitWidth: number
  private readonly nearby: IntersectionObserver
  private readonly visible: IntersectionObserver

  private scale: number
  private current = 1
  private disposed = false
  private rescaleTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: PageListOptions, first: PDFPageProxy) {
    this.pdfjs = options.pdfjs
    this.doc = options.doc
    this.container = options.container
    this.onPage = options.onPage
    this.onRealized = options.onRealized
    this.queue = options.queue
    this.scale = options.scale

    this.column.className = 'pdf__pages'
    this.column.style.setProperty('--pdf-scale', String(this.scale))

    const unit = first.getViewport({ scale: 1 })
    this.unitWidth = unit.width / first.userUnit
    for (let n = 1; n <= this.doc.numPages; n++) {
      const el = document.createElement('div')
      el.className = 'pdf__page'
      el.dataset.page = String(n)
      sizeBox(el, unit.width / first.userUnit, unit.height / first.userUnit)
      this.column.append(el)
      this.slots.push({
        n,
        el,
        canvas: null,
        textEl: null,
        hitsEl: null,
        page: null,
        task: null,
        text: null,
        textRendered: false,
        gen: 0,
        painted: 0,
        sized: false
      })
    }
    this.container.append(this.column)

    // One viewport of prefetch either way, measured once. The container's height changes when the
    // window is resized and this margin does not follow; the cost of that is slightly more or less
    // eager prefetch, which is not worth a ResizeObserver and a second observer rebuild.
    const margin = Math.max(400, this.container.clientHeight || 800)
    this.nearby = new IntersectionObserver((entries) => this.onNearby(entries), {
      root: this.container,
      rootMargin: `${margin}px 0px`
    })
    this.visible = new IntersectionObserver((entries) => this.onVisible(entries), {
      root: this.container
    })
    for (const slot of this.slots) {
      this.nearby.observe(slot.el)
      this.visible.observe(slot.el)
    }
  }

  get pageCount(): number {
    return this.doc.numPages
  }

  get currentScale(): number {
    return this.scale
  }

  /** The element to overlay search hits on, for a page that is currently realised. */
  overlayOf(n: number): { text: HTMLElement; hits: HTMLElement } | null {
    const slot = this.slots[n - 1]
    if (!slot?.textEl || !slot.hitsEl || !slot.textRendered) return null
    return { text: slot.textEl, hits: slot.hitsEl }
  }

  /**
   * Whether this page has a canvas in the column right now.
   *
   * The thumbnail rail asks before calling `page.cleanup()`: the two render the same PDFPageProxy,
   * and a thumbnail scrolling out of view must not throw away the operator list of a page the
   * reader is looking at.
   */
  isRealized(n: number): boolean {
    return this.slots[n - 1]?.canvas != null
  }

  /** The scale at which page 1 exactly fills the container's width. */
  fitWidth(): number {
    const width = this.container.clientWidth - PAGE_MARGIN * 2
    return width > 0 ? width / this.unitWidth : this.scale
  }

  scrollToPage(n: number): void {
    const slot = this.slots[Math.min(Math.max(n, 1), this.slots.length) - 1]
    if (!slot) return
    const top = slot.el.getBoundingClientRect().top
    const rootTop = this.container.getBoundingClientRect().top
    this.container.scrollTop += top - rootTop
  }

  /** Scroll so that a rectangle given in per-cent of a page's box is comfortably in view. */
  scrollToSpot(n: number, topPercent: number): void {
    const slot = this.slots[n - 1]
    if (!slot) return
    const box = slot.el.getBoundingClientRect()
    const rootTop = this.container.getBoundingClientRect().top
    const offset = (topPercent / 100) * box.height
    this.container.scrollTop += box.top - rootTop + offset - this.container.clientHeight / 3
  }

  setScale(scale: number): void {
    const previous = this.scale
    if (scale === previous || this.disposed) return
    this.scale = scale

    // The instant, blurry half: one variable write resizes every box, canvas and text layer,
    // because all three derive their size from it. Re-rendering per wheel tick instead would spend
    // the whole gesture cancelling renders that never finish.
    //
    // The scroll correction anchors the TOP of the viewport, not its centre. Centre-anchoring
    // reads better mid-document and is wrong in the one place it is most noticeable: at scrollTop
    // 0 it moves the centre point outwards, so opening a document at fit-width would jump half a
    // screen down before the reader had touched anything.
    const anchor = this.container.scrollTop / previous
    this.column.style.setProperty('--pdf-scale', String(scale))
    this.container.scrollTop = anchor * scale

    clearTimeout(this.rescaleTimer)
    this.rescaleTimer = setTimeout(() => {
      for (const slot of this.slots) {
        if (slot.canvas) this.realize(slot)
      }
    }, RESCALE_DEBOUNCE)
  }

  /** Where the reader is, for restoring the tab later. */
  snapshot(): { scrollTop: number; scale: number; page: number } {
    return { scrollTop: this.container.scrollTop, scale: this.scale, page: this.current }
  }

  restore(scrollTop: number): void {
    this.container.scrollTop = scrollTop
  }

  /**
   * Tear the column down, in the one order that actually frees everything.
   *
   * Returns a promise the document cache waits on before it destroys the loading task: that call
   * awaits every in-flight render before terminating the worker, so cancelling them first is what
   * makes a tab close promptly instead of after the last page finishes painting.
   */
  async destroy(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.rescaleTimer)
    this.nearby.disconnect()
    this.visible.disconnect()
    // Only this column's backlog: the queue is shared by every PDF pane in the window now, and
    // clearing all of it would leave the pane beside this one with blank pages.
    this.queue.clear(this)
    // Detached first, not last: the rest of this is asynchronous, and StrictMode's second mount
    // builds its column while this one is still cancelling renders. Two columns in one scroller
    // is a visible double-render in development. Painting into a detached canvas is harmless.
    this.column.remove()

    // 1. Every render task, cancelled and awaited.
    const tasks = this.slots.map((s) => s.task).filter((t): t is RenderTask => t !== null)
    for (const task of tasks) task.cancel()
    await Promise.all(tasks.map((task) => task.promise.catch(() => { /* cancelled */ })))

    for (const slot of this.slots) {
      slot.task = null
      // 2. Text layers. Cancelling rejects their render promise; nobody is listening by now.
      slot.text?.cancel()
      slot.text = null
      // 3. Pages — only now, because #tryCleanup bails while renderTasks.size > 0 and would
      //    silently leave the operator list and every decoded image pinned.
      try {
        slot.page?.cleanup()
      } catch {
        // The document may already be gone if the whole app is shutting down.
      }
      slot.page = null
      // 4. Canvases. Chromium holds the backing store of a detached canvas that still has a size.
      if (slot.canvas) {
        slot.canvas.width = 0
        slot.canvas.height = 0
        slot.canvas = null
      }
    }
    this.slots.length = 0
  }

  // ---------------------------------------------------------------------------
  // Virtualisation
  // ---------------------------------------------------------------------------

  private onNearby(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const slot = this.slotOf(entry.target)
      if (!slot) continue
      if (entry.isIntersecting) this.realize(slot)
      else void this.unrealize(slot)
    }
  }

  private onVisible(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const slot = this.slotOf(entry.target)
      if (!slot) continue
      if (entry.isIntersecting) this.onScreen.add(slot.n)
      else this.onScreen.delete(slot.n)
    }
    // The topmost page on screen is what a page indicator should say. Reported only on a change,
    // because this fires for every page that crosses the edge during a fast scroll.
    let top = Infinity
    for (const n of this.onScreen) top = Math.min(top, n)
    if (top !== Infinity && top !== this.current) {
      this.current = top
      this.onPage(top)
    }
  }

  private slotOf(target: Element): Slot | undefined {
    const n = Number((target as HTMLElement).dataset.page)
    return this.slots[n - 1]
  }

  private realize(slot: Slot): void {
    if (this.disposed) return
    if (slot.canvas && slot.painted === this.scale) return
    const gen = ++slot.gen

    this.queue.run(async () => {
      if (slot.gen !== gen || this.disposed) return
      const page = slot.page ?? (await this.doc.getPage(slot.n))
      if (slot.gen !== gen || this.disposed) return
      slot.page = page

      const scale = this.scale
      const viewport = page.getViewport({ scale })
      if (!slot.sized) this.correctBox(slot, page)

      // Re-rendering a canvas that is still rendering throws "Cannot use the same canvas during
      // multiple render() operations" — pdf.js keeps a static WeakSet of busy canvases — so the
      // old task goes first, and is awaited before the backing store is resized under it.
      if (slot.task) {
        const previous = slot.task
        slot.task = null
        previous.cancel()
        await previous.promise.catch(() => { /* cancelled */ })
        if (slot.gen !== gen || this.disposed) return
      }

      const canvas = slot.canvas ?? this.attachCanvas(slot)
      const output = new this.pdfjs.OutputScale()
      // CLAMP, or a 2x-DPR A0 page silently renders blank: past these limits Chromium refuses the
      // allocation and hands back a canvas that never paints.
      output.limitCanvas(viewport.width, viewport.height, MAX_CANVAS_PIXELS, MAX_CANVAS_DIM)
      canvas.width = Math.floor(viewport.width * output.sx)
      canvas.height = Math.floor(viewport.height * output.sy)

      const task = page.render({
        canvas,
        viewport,
        transform: output.scaled ? [output.sx, 0, 0, output.sy, 0, 0] : undefined
      })
      slot.task = task
      try {
        await task.promise
      } catch (e) {
        if (!isCancelled(e)) throw e
        return
      } finally {
        if (slot.task === task) slot.task = null
      }
      if (slot.gen !== gen || this.disposed) return
      slot.painted = scale

      // The text layer comes AFTER the canvas, never beside it: a dense CJK page is thousands of
      // absolutely-positioned spans, and building them while the bitmap is still being painted
      // costs the reader the one frame they are waiting for.
      await this.layText(slot, page, viewport, gen)
      if (slot.gen === gen && !this.disposed) this.onRealized(slot.n)
    }, { owner: this })
  }

  private async unrealize(slot: Slot): Promise<void> {
    // BUMPED BEFORE THE GUARD, never after. `realize` bumps `gen` and QUEUES a job; with a
    // concurrency of two and 50-300 ms a page, almost every job a fast scroll produces is still
    // unstarted when the page leaves the prefetch band, and such a slot has neither a canvas nor a
    // task because `attachCanvas` only runs inside the job. Guarding first therefore returned
    // without invalidating the pending job, which then found its generation still current and
    // corrected the box (shifting the column under the reader), rendered, and RETAINED a page
    // hundreds of rows off screen: dragging the scrollbar through a 300-page document ended with
    // 300 live canvases. `Thumb.detach` orders it this way for exactly the same reason.
    const gen = ++slot.gen
    // Nothing was ever built here — the bump above is the whole of the work.
    if (!slot.canvas && !slot.task) return

    const task = slot.task
    slot.task = null
    if (task) {
      task.cancel()
      await task.promise.catch(() => { /* cancelled */ })
      // The reader may have scrolled back in the time that took.
      if (slot.gen !== gen || this.disposed) return
    }

    slot.text?.cancel()
    slot.text = null
    slot.textRendered = false
    slot.textEl?.remove()
    slot.textEl = null
    slot.hitsEl?.remove()
    slot.hitsEl = null

    // Safe only now: while a render task was outstanding this returned false and did nothing.
    slot.page?.cleanup()

    if (slot.canvas) {
      slot.canvas.width = 0
      slot.canvas.height = 0
      slot.canvas.remove()
      slot.canvas = null
    }
    slot.painted = 0
  }

  // ---------------------------------------------------------------------------
  // Per-page DOM
  // ---------------------------------------------------------------------------

  private attachCanvas(slot: Slot): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    canvas.className = 'pdf__canvas'
    slot.el.append(canvas)
    slot.canvas = canvas
    return canvas
  }

  /**
   * Replace the guess made from page 1 with this page's own dimensions.
   *
   * Sized from the RAW dimensions and scaled by the CSS variable, because that is the arithmetic
   * pdf.js's own `setLayerDimensions` does for the text layer — anything else and the selection
   * drifts a pixel away from the glyphs. `userUnit` is folded into the variable rather than the
   * box for the same reason: `rawDims` does not know about it, so the text layer would disagree.
   */
  private correctBox(slot: Slot, page: PDFPageProxy): void {
    const unit = page.getViewport({ scale: 1 })
    const userUnit = page.userUnit
    sizeBox(slot.el, unit.width / userUnit, unit.height / userUnit)
    if (userUnit !== 1) {
      slot.el.style.setProperty('--total-scale-factor', `calc(var(--pdf-scale) * ${userUnit})`)
    }
    // Pages with an intrinsic /Rotate render rotated on the canvas, but the text layer is always
    // laid out in the unrotated page's coordinates — pdf.js's viewer rotates it in CSS and so do
    // we, keyed off this attribute.
    slot.el.dataset.rotation = String(((unit.rotation % 360) + 360) % 360)
    slot.sized = true
  }

  private async layText(
    slot: Slot,
    page: PDFPageProxy,
    viewport: PageViewport,
    gen: number
  ): Promise<void> {
    // A relayout of the existing spans, which is what a zoom needs: `update` re-measures without
    // streaming the page's text content out of the worker a second time.
    if (slot.text && slot.textRendered) {
      slot.text.update({ viewport })
      return
    }
    slot.text?.cancel()

    const textEl = slot.textEl ?? document.createElement('div')
    if (!slot.textEl) {
      textEl.className = 'textLayer'
      slot.el.append(textEl)
      slot.textEl = textEl
    }
    textEl.replaceChildren()

    if (!slot.hitsEl) {
      const hits = document.createElement('div')
      hits.className = 'pdf__hits'
      slot.el.append(hits)
      slot.hitsEl = hits
    }

    const text = new this.pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textEl,
      viewport
    })
    slot.text = text
    try {
      await text.render()
    } catch {
      // cancel() rejects with an AbortException. Nothing to report: either we are tearing down or
      // the reader scrolled past.
      return
    }
    if (slot.gen === gen) slot.textRendered = true
  }
}

/**
 * Size a box the way pdf.js sizes its layers: from the unscaled dimensions and the scale variable,
 * rounded down to a whole pixel.
 *
 * `--scale-round-x` / `--scale-round-y` are set to 1px in the stylesheet. Without them the
 * `round()` expression collapses to nothing and every layer ends up zero-sized — which is the
 * single most confusing way for a PDF to render blank.
 */
function sizeBox(el: HTMLElement, width: number, height: number): void {
  el.style.width = `round(down, var(--total-scale-factor) * ${width}px, var(--scale-round-x))`
  el.style.height = `round(down, var(--total-scale-factor) * ${height}px, var(--scale-round-y))`
}

/** A cancelled render rejects. It is the normal way a scroll ends, not a failure. */
function isCancelled(e: unknown): boolean {
  return e instanceof Error && e.name === 'RenderingCancelledException'
}
