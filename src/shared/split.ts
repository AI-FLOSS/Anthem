// Split-pane sizing arithmetic.
//
// gmusicbrowser layouts declare sizes like HPmain(size=400) and VPRight(size=200-550); X-Music needs
// the same, but the interesting part is not the DOM — it is deciding what a drag is allowed to do
// when panes have minimums, when a neighbour is already at its limit, and when the window resizes.
// That logic lives here so it is testable and survives any UI-framework decision.

export interface PaneSpec {
  /** Smallest the pane may become, in pixels. */
  min?: number
  /** Largest the pane may become, in pixels. */
  max?: number
  /** Whether the pane absorbs leftover space when the container resizes. */
  grow?: boolean
}

const DEFAULT_MIN = 40

const minOf = (spec: PaneSpec | undefined): number => spec?.min ?? DEFAULT_MIN
const maxOf = (spec: PaneSpec | undefined): number => spec?.max ?? Number.POSITIVE_INFINITY

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

/**
 * Moves the boundary between pane `index` and pane `index + 1` by `delta` pixels.
 *
 * Only the two adjacent panes change, which is what makes dragging predictable: a gutter never
 * silently reflows panes elsewhere in the split. The delta is clamped so that neither neighbour
 * breaks its own min or max, so an over-drag stops at the limit instead of being rejected.
 */
export function resizeAt(
  sizes: readonly number[],
  index: number,
  delta: number,
  specs: readonly PaneSpec[] = []
): number[] {
  const a = sizes[index]
  const b = sizes[index + 1]
  if (a === undefined || b === undefined) return [...sizes]

  const specA = specs[index]
  const specB = specs[index + 1]

  // How far the boundary may travel in each direction before something hits a limit.
  const maxGrowA = Math.min(maxOf(specA) - a, b - minOf(specB))
  const maxShrinkA = Math.min(a - minOf(specA), maxOf(specB) - b)

  const applied = clamp(delta, -maxShrinkA, maxGrowA)

  const next = [...sizes]
  next[index] = a + applied
  next[index + 1] = b - applied
  return next
}

/**
 * Fits panes to a container width, preserving their proportions where possible.
 *
 * Panes marked `grow` absorb the difference first; if none are, the surplus or deficit is spread
 * proportionally. Minimums always win, which means a container too small for every minimum will
 * overflow rather than collapse panes to nothing — visible breakage beats invisible data loss.
 */
export function fit(
  sizes: readonly number[],
  total: number,
  specs: readonly PaneSpec[] = []
): number[] {
  if (sizes.length === 0) return []

  const next = [...sizes]
  const current = next.reduce((s, v) => s + v, 0)
  let diff = total - current
  if (Math.abs(diff) < 0.5) return next.map((v) => Math.round(v))

  const growers = next.map((_, i) => i).filter((i) => specs[i]?.grow)
  const targets = growers.length > 0 ? growers : next.map((_, i) => i)

  // Several passes, because a pane hitting its limit hands the remainder back to the others.
  for (let pass = 0; pass < 4 && Math.abs(diff) > 0.5; pass++) {
    const room = targets.filter((i) => {
      const v = next[i]!
      return diff > 0 ? v < maxOf(specs[i]) : v > minOf(specs[i])
    })
    if (room.length === 0) break

    const share = diff / room.length
    for (const i of room) {
      const before = next[i]!
      next[i] = clamp(before + share, minOf(specs[i]), maxOf(specs[i]))
      diff -= next[i]! - before
    }
  }

  return next.map((v) => Math.round(v))
}

/** Initial sizes for a container, honouring minimums. */
export function distribute(
  total: number,
  specs: readonly PaneSpec[],
  preferred?: readonly (number | undefined)[]
): number[] {
  const seeds = specs.map((spec, i) => preferred?.[i] ?? spec.min ?? total / specs.length)
  return fit(seeds, total, specs)
}

/** Keyboard resizing: a step per arrow press, larger with a modifier. */
export const KEYBOARD_STEP = 16
export const KEYBOARD_STEP_LARGE = 64
