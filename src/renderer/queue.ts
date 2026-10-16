/**
 * Two-tier render scheduling, because pdf.js does not cap concurrency and we have to.
 *
 * pdf.js already slices a page's operator list at 15 ms and resumes on rAF, so ONE render is a
 * good citizen. Nothing stops six pages doing that at once, though, and six well-behaved slices
 * still add up to six times the frame budget — which is exactly what a fast scroll through a
 * thumbnail rail produces.
 *
 * So: at most `limit` renders in flight, and a low tier that only starts when the high tier is
 * completely idle. Thumbnails live in the low tier, so they can never delay the page the reader is
 * actually looking at, and a scroll that re-fills the high tier pauses them mid-rail.
 *
 * ONE of these serves the whole window (see PdfView). That is what makes the limit mean anything
 * now that two PDFs can sit side by side — but it also means the backlog belongs to several panes
 * at once, so every job carries the OWNER that queued it and a pane may only drop its own.
 */
export type RenderJob = () => Promise<void>

export interface RenderOptions {
  /** Start only when the high tier is completely idle. Thumbnails, and nothing else so far. */
  low?: boolean
  /**
   * Whoever queued it, as an identity to cancel by. Any object will do — the page column passes
   * itself. Omitting it means no `clear` can ever reach the job, which is right for one that
   * checks its own generation and returns immediately: the thumbnail rail's, and only those.
   */
  owner?: object
}

interface Queued {
  job: RenderJob
  owner: object | undefined
}

export class RenderQueue {
  private active = 0
  private readonly high: Queued[] = []
  private readonly low: Queued[] = []

  constructor(private readonly limit = 2) {}

  run(job: RenderJob, options: RenderOptions = {}): void {
    ;(options.low ? this.low : this.high).push({ job, owner: options.owner })
    this.pump()
  }

  /**
   * Forget one owner's not-yet-started jobs. In-flight jobs are cancelled by their own owners.
   *
   * Scoped, and that is load-bearing: a pane that cleared the whole queue on unmount would drop
   * the queued pages of the pane beside it, and those pages stay blank until something makes the
   * intersection observer fire again — a stall with no error and no obvious cause.
   */
  clear(owner: object): void {
    drop(this.high, owner)
    drop(this.low, owner)
  }

  private pump(): void {
    while (this.active < this.limit) {
      // The low tier waits for a completely quiet high tier, not merely a free slot: "lower
      // priority" that still gets a slot while a page is rendering is not lower priority.
      const next = this.high.shift() ?? (this.active === 0 ? this.low.shift() : undefined)
      if (!next) return
      this.active++
      void next
        .job()
        .catch(() => { /* every job reports its own failure; the queue only counts */ })
        .finally(() => {
          this.active--
          this.pump()
        })
    }
  }
}

function drop(queued: Queued[], owner: object): void {
  const kept = queued.filter((q) => q.owner !== owner)
  queued.length = 0
  queued.push(...kept)
}
