import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { ipc } from '../../lib/ipc'
import { cx } from '../../lib/cx'
import type { FileOutcome, FileResult, Root, ScanProgress, ScanReport } from '@shared/ipc'
import { library } from '../../stores/library'
import { virtualWindow } from '@shared/view'
import s from './ScanPanel.module.css'

const ROW = 24

const OUTCOMES: { id: FileOutcome; label: string }[] = [
  { id: 'new', label: 'New' },
  { id: 'matched', label: 'Matched' },
  { id: 'moved', label: 'Moved' },
  { id: 'unchanged', label: 'Unchanged' },
  { id: 'missing', label: 'Missing' },
  { id: 'error', label: 'Failed' }
]

const short = (p: string | undefined): string =>
  p ? (p.length > 72 ? `…${p.slice(-71)}` : p) : ''

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

export function ScanPanel() {
  const [roots, setRoots] = useState<Root[]>([])
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [report, setReport] = useState<ScanReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)

  // Every file's outcome is kept; the table renders only the rows in view.
  const [results, setResults] = useState<FileResult[]>([])
  const [filter, setFilter] = useState<FileOutcome | 'all'>('all')
  const [follow, setFollow] = useState(true)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(320)
  const body = useRef<HTMLDivElement>(null)
  const hasResults = results.length > 0

  const tally = useMemo(() => {
    const t: Record<string, number> = {}
    for (const r of results) t[r.outcome] = (t[r.outcome] ?? 0) + 1
    return t
  }, [results])

  const shown = useMemo(
    () => (filter === 'all' ? results : results.filter((r) => r.outcome === filter)),
    [results, filter]
  )
  const win = virtualWindow(shown.length, ROW, scrollTop, viewport)
  const slice = shown.slice(win.start, win.end)

  useEffect(() => {
    // Following the tail is only helpful while rows are still arriving.
    const el = body.current
    if (follow && scanning && el) el.scrollTop = el.scrollHeight
  }, [results.length, follow, scanning])

  useEffect(() => {
    const el = body.current
    if (!el) return
    const observer = new ResizeObserver(() => setViewport(el.clientHeight))
    observer.observe(el)
    setViewport(el.clientHeight)
    return () => observer.disconnect()
  }, [hasResults])

  useEffect(() => {
    void load()
    const offProgress = window.xMusicEvents.on('scan:progress', (p) => setProgress(p))
    const offFiles = window.xMusicEvents.on('scan:files', (batch) => {
      setResults((prev) => [...prev, ...batch])
    })
    const offDone = window.xMusicEvents.on('scan:done', (r) => {
      setReport(r)
      setProgress(null)
      setScanning(false)
      void library.refresh()
    })
    return () => { offProgress(); offFiles(); offDone() }
  }, [])

  async function load(): Promise<void> {
    try {
      setRoots(await ipc('library:roots'))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function add(): Promise<void> {
    try {
      setError(null)
      const added = await ipc('library:addRoot')
      if (added) await load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function remove(id: number): Promise<void> {
    await ipc('library:removeRoot', id)
    await load()
  }

  async function scan(): Promise<void> {
    setError(null)
    setReport(null)
    setResults([])
    setFilter('all')
    setFollow(true)
    setScanning(true)
    try {
      await ipc('library:scan')
    } catch (err) {
      setError((err as Error).message)
      setScanning(false)
      setProgress(null)
    }
  }

  async function cancel(): Promise<void> {
    await ipc('library:scanCancel')
  }

  const pct =
    progress && progress.found > 0
      ? Math.round((progress.processed / progress.found) * 100)
      : 0

  const onScroll = (e: Event): void => {
    const el = e.currentTarget as HTMLDivElement
    setScrollTop(el.scrollTop)
    // Scrolling up by hand means the user wants to read, not chase the tail.
    if (scanning && el.scrollTop + el.clientHeight < el.scrollHeight - 8) setFollow(false)
  }

  return (
    <section class={s.scan}>
      <header class={s.header}>
        <h2 class={s.heading}>Music folders</h2>
        <p class={s.lead}>
          X-Music reads these folders to build the library. Files are only ever read, never modified.
        </p>
      </header>

      {roots.length ? (
        <ul class={s.roots}>
          {roots.map((r) => (
            <li key={r.id}>
              <code class={s.code}>{r.path}</code>
              <span class={s.when}>
                {r.lastScan ? `scanned ${new Date(r.lastScan).toLocaleString()}` : 'never scanned'}
              </span>
              <button class={cx(s.button, s.remove)} onClick={() => remove(r.id)} disabled={scanning}>Remove</button>
            </li>
          ))}
        </ul>
      ) : (
        <p class={s.note}>No folders yet. Add one to scan, or import from gmusicbrowser instead.</p>
      )}

      <div class={s.actions}>
        <button class={s.button} onClick={add} disabled={scanning}>Add folder…</button>
        <button class={cx(s.button, s.primary)} onClick={scan} disabled={scanning || roots.length === 0}>
          {scanning ? 'Scanning…' : 'Scan now'}
        </button>
        {scanning && <button class={s.button} onClick={cancel}>Cancel</button>}
      </div>

      {progress && (
        <div class={s.progress}>
          <div class={s.bar}><div class={s.fill} style={{ width: `${pct}%` }}></div></div>
          <div class={s.detail}>
            {progress.phase === 'walking'
              ? `Finding files… ${progress.found.toLocaleString()}`
              : progress.phase === 'finishing'
                ? 'Checking for files that disappeared…'
                : `${progress.processed.toLocaleString()} / ${progress.found.toLocaleString()}`}
          </div>
        </div>
      )}

      {hasResults && (
        <div class={s.results}>
          <div class={s.filters}>
            <button class={cx(s.button, filter === 'all' && s.sel)} onClick={() => setFilter('all')}>
              All <span class={s.n}>{results.length.toLocaleString()}</span>
            </button>
            {OUTCOMES.map((o) =>
              tally[o.id] ? (
                <button key={o.id} class={cx(s.button, s[o.id], filter === o.id && s.sel)}
                        onClick={() => setFilter(o.id)}>
                  {o.label} <span class={s.n}>{tally[o.id]!.toLocaleString()}</span>
                </button>
              ) : null
            )}
            <span class={s.grow}></span>
            <label class={s.follow}>
              <input type="checkbox" checked={follow} disabled={!scanning}
                     onChange={(e) => setFollow((e.currentTarget as HTMLInputElement).checked)} /> Follow
            </label>
          </div>

          <div class={s.body} ref={body} onScroll={onScroll}>
            <div class={s.spacer} style={{ height: `${win.totalPx}px` }}>
              <div class={s.rows} style={{ transform: `translateY(${win.offsetPx}px)` }}>
                {slice.map((r, i) => (
                  <div key={win.start + i} class={s.row} style={{ height: `${ROW}px` }}>
                    <span class={cx(s.badge, s[r.outcome])}>{r.outcome}</span>
                    <span class={s.file} title={r.path}>{short(r.path)}</span>
                    <span class={s.why}>{r.detail ?? ''}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {error && <p class={cx(s.note, s.err)}>{error}</p>}

      {report && (
        <div class={s.report}>
          <p>
            Scanned <strong>{report.filesFound.toLocaleString()}</strong> files in{' '}
            {seconds(report.durationMs)} —{' '}
            <strong>{report.tracksCreated.toLocaleString()}</strong> new,{' '}
            <strong>{report.tracksMatched.toLocaleString()}</strong> already known,{' '}
            <strong>{report.filesSkipped.toLocaleString()}</strong> unchanged.
          </p>
          {report.movesDetected > 0 && (
            <p class={s.note}>
              {report.movesDetected} moved or renamed file{report.movesDetected === 1 ? '' : 's'}{' '}
              recognised by audio content, keeping ratings and play history.
            </p>
          )}
          {report.markedMissing > 0 && (
            <p class={cx(s.note, s.warn)}>
              {report.markedMissing} file{report.markedMissing === 1 ? '' : 's'} no longer on disk.
              Flagged as missing; their tracks and statistics are kept.
            </p>
          )}
          {report.errors.length > 0 && (
            <>
              <p class={cx(s.note, s.warn)}>{report.errors.length} file(s) could not be read:</p>
              <ul class={s.errors}>
                {report.errors.slice(0, 5).map((e) => (
                  <li key={e.path}><code class={s.code}>{short(e.path)}</code> — {e.message}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  )
}
