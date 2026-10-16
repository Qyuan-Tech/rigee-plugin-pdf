import { icons } from '@rigee/plugin-api'
import { useCallback, useEffect, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

/**
 * The document's own table of contents.
 *
 * Destinations are resolved ON CLICK, never at open. A named destination costs a worker round-trip
 * to look up and a second one to turn the resulting reference into a page index; a 600-entry
 * outline would be 1,200 of them before the first page paints, to compute numbers the reader may
 * never ask for.
 */

interface Entry {
  title: string
  /** A named destination, an explicit one, or null for an entry that only groups its children. */
  dest: string | unknown[] | null
  items: Entry[]
}

/** Long enough to read a line of error text, short enough not to become part of the furniture. */
const TROUBLE_LINGER = 4000

export function Outline({
  doc,
  onGo
}: {
  doc: PDFDocumentProxy
  onGo: (page: number) => void
}): React.ReactElement {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  /** Fatal, and only ever from `getOutline()`: there is genuinely no tree to show. */
  const [error, setError] = useState<string | null>(null)
  /**
   * One row's jump failed. A SEPARATE channel from `error`, and that separation is the whole
   * point: files re-assembled by lossy generators keep outline entries whose destination no longer
   * resolves to a /Page dictionary, the worker throws for that one row, and writing it to `error`
   * replaced the entire table of contents — every working entry included — with a banner that
   * nothing ever cleared. Boxed in an object so that clicking a second broken row is a new value
   * and restarts the timer below, rather than being swallowed as an unchanged string.
   */
  const [trouble, setTrouble] = useState<{ message: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    // A new document is a new verdict on both channels: a banner about a row in the previous
    // document's tree outlives every row it could refer to.
    setError(null)
    setTrouble(null)
    void (async () => {
      try {
        const outline = await doc.getOutline()
        if (!cancelled) setEntries(adopt(outline ?? []))
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [doc])

  // Transient by construction: a stale "that entry is broken" sitting above a tree the reader has
  // since navigated with successfully would read as if the outline itself were broken.
  useEffect(() => {
    if (!trouble) return
    const timer = setTimeout(() => setTrouble(null), TROUBLE_LINGER)
    return () => { clearTimeout(timer) }
  }, [trouble])

  const go = useCallback(
    (dest: Entry['dest']) => {
      void (async () => {
        try {
          const page = await pageOf(doc, dest)
          if (page !== null) onGo(page)
          setTrouble(null)
        } catch (e) {
          setTrouble({ message: e instanceof Error ? e.message : String(e) })
        }
      })()
    },
    [doc, onGo]
  )

  if (error) return <div className="error-banner">{error}</div>
  if (!entries) return <div className="muted">Reading the outline…</div>
  if (entries.length === 0) return <div className="muted">This document has no outline.</div>

  return (
    <>
      {trouble && (
        <div className="error-banner" onClick={() => setTrouble(null)} title="Dismiss">
          {trouble.message}
        </div>
      )}
      <div className="pdf__tree">
        {entries.map((entry, i) => (
          <OutlineRow key={i} entry={entry} depth={0} onGo={go} />
        ))}
      </div>
    </>
  )
}

function OutlineRow({
  entry,
  depth,
  onGo
}: {
  entry: Entry
  depth: number
  onGo: (dest: Entry['dest']) => void
}): React.ReactElement {
  // Top-level entries start open, deeper ones closed: that is the shape of a table of contents
  // someone would print, and it keeps a 600-entry outline to one screen.
  const [open, setOpen] = useState(depth === 0)
  const branch = entry.items.length > 0

  return (
    <>
      <div className="pdf__tree-row" style={{ paddingLeft: 8 + depth * 12 }}>
        {branch ? (
          <button
            className="pdf__twisty"
            onClick={() => setOpen((v) => !v)}
            title={open ? 'Collapse' : 'Expand'}
          >
            <icons.Chevron open={open} />
          </button>
        ) : (
          <span className="pdf__twisty" />
        )}
        <button className="pdf__tree-title" onClick={() => onGo(entry.dest)} title={entry.title}>
          {entry.title || '(untitled)'}
        </button>
      </div>
      {open &&
        entry.items.map((child, i) => (
          <OutlineRow key={i} entry={child} depth={depth + 1} onGo={onGo} />
        ))}
    </>
  )
}

/** pdf.js types the nested `items` as any[]; narrow it once, here, rather than everywhere. */
function adopt(raw: { title: string; dest: string | unknown[] | null; items: unknown[] }[]): Entry[] {
  return raw.map((node) => ({
    title: node.title,
    dest: node.dest,
    items: adopt((node.items ?? []) as Parameters<typeof adopt>[0])
  }))
}

/**
 * Turn a destination into a 1-based page number.
 *
 * A destination is either a name to look up or an explicit array whose first element is the page:
 * a reference object for an ordinary document, or a plain integer page index for the rare
 * destination that names one directly.
 */
async function pageOf(doc: PDFDocumentProxy, dest: string | unknown[] | null): Promise<number | null> {
  if (dest === null) return null
  const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest
  const ref = explicit?.[0]
  if (typeof ref === 'number') return ref + 1
  if (ref === null || typeof ref !== 'object') return null
  return (await doc.getPageIndex(ref as { num: number; gen: number })) + 1
}
