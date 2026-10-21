// A resizable split. All the sizing decisions live in shared/split.ts; this component only binds
// them to pointer and keyboard events and writes the result into a grid template.

import { Fragment, type ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import {
  KEYBOARD_STEP, KEYBOARD_STEP_LARGE, distribute, fit, resizeAt, type PaneSpec
} from '@shared/split'
import { cx } from './cx'
import s from './Split.module.css'

export function Split({
  id,
  dir = 'horizontal',
  specs,
  preferred,
  panes
}: {
  /** Stable id; pane sizes are remembered under it. */
  id: string
  dir?: 'horizontal' | 'vertical'
  specs: PaneSpec[]
  preferred?: (number | undefined)[]
  panes: ComponentChildren[]
}) {
  // The id is fixed configuration for the lifetime of the split.
  const storage = useRef(`x-music.split.${id}`).current

  const container = useRef<HTMLDivElement>(null)
  const [sizes, setSizes] = useState<number[]>([])
  const [dragging, setDragging] = useState<number | null>(null)

  // Handlers attached outside render read the latest sizes through this.
  const sizesRef = useRef(sizes)
  sizesRef.current = sizes

  /** The space the panes share: the container minus its gutters, which the grid also lays out. */
  function extent(): number {
    const el = container.current
    if (!el) return 0
    const along = (e: HTMLElement): number => (dir === 'horizontal' ? e.offsetWidth : e.offsetHeight)
    const gutters = [...el.children]
      .filter((c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains(s.gutter!))
      .reduce((sum, g) => sum + along(g), 0)
    return (dir === 'horizontal' ? el.clientWidth : el.clientHeight) - gutters
  }

  function persist(next: number[]): void {
    try {
      localStorage.setItem(storage, JSON.stringify(next))
    } catch {
      // A full or unavailable localStorage must not break resizing.
    }
  }

  function restore(): number[] | null {
    try {
      const raw = localStorage.getItem(storage)
      if (!raw) return null
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed) || parsed.length !== specs.length) return null
      if (!parsed.every((v) => typeof v === 'number' && Number.isFinite(v))) return null
      return parsed as number[]
    } catch {
      return null
    }
  }

  useEffect(() => {
    const el = container.current
    if (!el) return

    const total = extent()
    if (total > 0 && sizesRef.current.length !== specs.length) {
      const saved = restore()
      setSizes(saved ? fit(saved, total, specs) : distribute(total, specs, preferred))
    }

    // Keep panes filling the container as the window changes.
    // Writing sizes straight from the observer callback resizes the very element being observed,
    // which trips "ResizeObserver loop completed with undelivered notifications". Deferring to the
    // next frame lets the current layout pass finish first.
    let queued = 0
    const observer = new ResizeObserver(() => {
      if (queued) return
      queued = requestAnimationFrame(() => {
        queued = 0
        const t = extent()
        if (t <= 0) return
        const current = sizesRef.current
        if (current.length === specs.length) setSizes(fit(current, t, specs))
        else {
          const saved = restore()
          setSizes(saved ? fit(saved, t, specs) : distribute(t, specs, preferred))
        }
      })
    })
    observer.observe(el)
    return () => {
      if (queued) cancelAnimationFrame(queued)
      observer.disconnect()
    }
  }, [])

  function startDrag(index: number, event: PointerEvent): void {
    event.preventDefault()
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)

    const origin = dir === 'horizontal' ? event.clientX : event.clientY
    const before = [...sizesRef.current]
    let last = before
    setDragging(index)

    const move = (e: PointerEvent): void => {
      const now = dir === 'horizontal' ? e.clientX : e.clientY
      last = resizeAt(before, index, now - origin, specs)
      setSizes(last)
    }

    const done = (): void => {
      setDragging(null)
      handle.releasePointerCapture(event.pointerId)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', done)
      handle.removeEventListener('pointercancel', done)
      persist(last)
    }

    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', done)
    handle.addEventListener('pointercancel', done)
  }

  function onKey(index: number, event: KeyboardEvent): void {
    const back = dir === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
    const forward = dir === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
    if (event.key !== back && event.key !== forward) return

    event.preventDefault()
    const step = event.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP
    const next = resizeAt(sizes, index, event.key === forward ? step : -step, specs)
    setSizes(next)
    persist(next)
  }

  /** Double-click restores the layout's own proportions. */
  function reset(): void {
    const next = distribute(extent(), specs, preferred)
    setSizes(next)
    persist(next)
  }

  const template = sizes.length === specs.length
    ? sizes.flatMap((v, i) => (i === 0 ? [`${v}px`] : ['auto', `${v}px`])).join(' ')
    : specs.map(() => '1fr').join(' auto ')

  return (
    <div
      class={cx(s.split, dir === 'horizontal' ? s.horizontal : s.vertical, dragging !== null && s.dragging)}
      ref={container}
      style={dir === 'horizontal' ? { gridTemplateColumns: template } : { gridTemplateRows: template }}
    >
      {panes.map((pane, i) => (
        <Fragment key={i}>
          {i > 0 && (
            // A focusable role="separator" with aria-valuenow is the ARIA window-splitter pattern.
            <div
              class={cx(s.gutter, dragging === i - 1 && s.active)}
              role="separator"
              tabIndex={0}
              aria-orientation={dir === 'horizontal' ? 'vertical' : 'horizontal'}
              aria-label="Resize panes"
              aria-valuenow={sizes[i - 1] ?? 0}
              onPointerDown={(e) => startDrag(i - 1, e)}
              onKeyDown={(e) => onKey(i - 1, e)}
              onDblClick={reset}
            ><span class={s.grip}></span></div>
          )}
          <div class={s.pane}>{pane}</div>
        </Fragment>
      ))}
    </div>
  )
}
