import { useEffect, useRef, useState } from 'react'
import type { RenderQueue } from './queue'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'

/** CSS pixels. Wide enough to recognise a page by its layout, narrow enough for a 200px rail. */
const THUMB_WIDTH = 116

/**
 * The page rail.
 *
 * Every thumbnail goes through the SAME queue as the main column, in its low tier, which is the
 * only thing that makes this pane safe to open: the queue starts a thumbnail only when no page
 * render is running or waiting, so dragging the rail through a 500-page book cannot take a frame
 * away from the page being read.
 *
 * Thumbnails are virtualised for memory, not for layout. A 116px thumbnail on a 2x display is
 * about 280 kB of backing store; keeping all 500 would be 140 MB of canvas for a pane most people
 * glance at, so a row that scrolls out of the rail gives its canvas back and re-renders on return.
 *
 * Visibility is tracked by ONE shared IntersectionObserver rather than one per row: 500 observers
 * is 500 registrations for the compositor to walk, and the alternative — holding the visible set
 * in React state — re-renders the whole rail on every scroll batch.
 */
export function Thumbnails({
  doc,
  queue,
  current,
  canCleanup,
  onGo
}: {
  doc: PDFDocumentProxy
  queue: RenderQueue
  current: number
  /** False while the main column holds this page, in which case cleanup is not ours to do. */
  canCleanup: (n: number) => boolean
  onGo: (page: number) => void
}): React.ReactElement {
  const rail = useRef<HTMLDivElement>(null)
  const [watcher, setWatcher] = useState<Watcher | null>(null)

  useEffect(() => {
    if (!rail.current) return
    const live = new Watcher(rail.current)
    setWatcher(live)
    return () => {
      setWatcher(null)
      live.dispose()
    }
  }, [])

  // Follow the reader through the document, but only within the rail: `block: 'nearest'` is what
  // stops this dragging the page column along with it.
  useEffect(() => {
    rail.current?.querySelector(`[data-thumb="${current}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const pages: number[] = []
  for (let n = 1; n <= doc.numPages; n++) pages.push(n)

  return (
    <div className="pdf__rail" ref={rail}>
      {watcher &&
        pages.map((n) => (
          <Thumb
            key={n}
            n={n}
            doc={doc}
            queue={queue}
            watcher={watcher}
            active={n === current}
            canCleanup={canCleanup}
            onGo={onGo}
          />
        ))}
    </div>
  )
}

function Thumb({
  n,
  doc,
  queue,
  watcher,
  active,
  canCleanup,
  onGo
}: {
  n: number
  doc: PDFDocumentProxy
  queue: RenderQueue
  watcher: Watcher
  active: boolean
  canCleanup: (n: number) => boolean
  onGo: (page: number) => void
}): React.ReactElement {
  const host = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return

    let disposed = false
    let generation = 0
    let task: RenderTask | null = null
    let canvas: HTMLCanvasElement | null = null

    const attach = (): void => {
      if (canvas || disposed) return
      const mine = ++generation
      queue.run(async () => {
        if (disposed || generation !== mine) return
        const page = await doc.getPage(n)
        if (disposed || generation !== mine) return

        const ratio = window.devicePixelRatio || 1
        const unit = page.getViewport({ scale: 1 })
        // The device pixel ratio goes into the viewport scale rather than through a render
        // transform: a thumbnail cannot approach a canvas size limit, so the clamping the main
        // column needs would be ceremony here.
        const viewport = page.getViewport({ scale: (THUMB_WIDTH * ratio) / unit.width })

        const fresh = document.createElement('canvas')
        fresh.className = 'pdf__thumb-canvas'
        fresh.width = Math.floor(viewport.width)
        fresh.height = Math.floor(viewport.height)
        el.style.height = `${Math.round(viewport.height / ratio)}px`
        el.replaceChildren(fresh)
        canvas = fresh

        const started = page.render({ canvas: fresh, viewport })
        task = started
        try {
          await started.promise
        } catch {
          // Cancelled by scrolling away or by the tab closing. Neither is news.
        } finally {
          if (task === started) task = null
        }
      }, { low: true })
    }

    const detach = (): void => {
      generation++
      // Nothing was ever attached, so there is nothing to give back — and reaching the chain below
      // would be actively harmful. An IntersectionObserver delivers an initial entry for EVERY
      // target it observes, including the ones that are not intersecting, so opening the rail on a
      // 500-page book lands here ~495 times in one batch; without this the `canCleanup` branch
      // would post ~495 getPage messages to the FIFO worker at once and the render and text
      // extraction the main column is waiting on would queue behind all of them, stalling the page
      // the reader is actually looking at. A row whose attach job is merely still queued takes the
      // same exit: the bump above has already invalidated it.
      if (!task && !canvas) return

      const dying = task
      const dead = canvas
      task = null
      canvas = null
      dying?.cancel()
      void Promise.resolve(dying?.promise)
        .catch(() => { /* cancelled */ })
        .then(() => {
          if (dead) {
            // Chromium keeps the backing store of a detached canvas that still has a size.
            dead.width = 0
            dead.height = 0
            dead.remove()
          }
          // Only after the render is cancelled, and only if the main column is not holding this
          // page: the two views share one PDFPageProxy.
          if (canCleanup(n)) {
            void doc.getPage(n).then((page) => page.cleanup()).catch(() => { /* gone */ })
          }
        })
    }

    const stop = watcher.watch(el, (visible) => {
      if (visible) { attach(); return }
      detach()
    })

    return () => {
      disposed = true
      stop()
      detach()
    }
    // `canCleanup` is a stable callback over a ref; listing it would rebuild every thumbnail in
    // the rail each time the pane re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, n, queue, watcher])

  return (
    <div className={active ? 'pdf__thumb pdf__thumb--active' : 'pdf__thumb'}>
      <button
        className="pdf__thumb-box"
        data-thumb={n}
        ref={host}
        onClick={() => onGo(n)}
        title={`Page ${n}`}
      />
      <span className="pdf__thumb-no">{n}</span>
    </div>
  )
}

/** One IntersectionObserver, many rows. */
class Watcher {
  private readonly callbacks = new Map<Element, (visible: boolean) => void>()
  private readonly observer: IntersectionObserver

  constructor(root: Element) {
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) this.callbacks.get(entry.target)?.(entry.isIntersecting)
      },
      { root, rootMargin: '300px 0px' }
    )
  }

  watch(el: Element, callback: (visible: boolean) => void): () => void {
    this.callbacks.set(el, callback)
    this.observer.observe(el)
    return () => {
      this.callbacks.delete(el)
      this.observer.unobserve(el)
    }
  }

  dispose(): void {
    this.observer.disconnect()
    this.callbacks.clear()
  }
}
