// The playback engine boundary.
//
// X-Music's own logic — what plays next, when a play counts, which file of a track to use — lives in
// player.ts and knows nothing about mpv. This interface is the seam, so a second backend (Web Audio,
// or a native decoder) is a swap rather than a rewrite, and so the player can be tested against a
// fake without spawning a process.

export type EngineState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'

export interface LoadOptions {
  /** For CUE ranges and chapters: play only part of the container. */
  startMs?: number | null
  endMs?: number | null
  /** ReplayGain adjustment in dB, already resolved to track or album preference. */
  gainDb?: number | null
}

export interface EngineEvents {
  /** Throttled by the engine; the UI interpolates between ticks. */
  position: { positionMs: number; durationMs: number | null }
  state: { state: EngineState; error?: string }
  /** The current item finished on its own, as opposed to being replaced. */
  ended: Record<string, never>
}

export type EngineListener = <E extends keyof EngineEvents>(
  event: E,
  payload: EngineEvents[E]
) => void

export interface PlaybackEngine {
  load(uri: string, opts?: LoadOptions): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  stop(): Promise<void>
  seek(positionMs: number): Promise<void>
  setVolume(volume: number): Promise<void>
  /** Hint the next file so the backend can prepare a gapless transition. */
  preload?(uri: string, opts?: LoadOptions): Promise<void>
  subscribe(listener: EngineListener): () => void
  dispose(): Promise<void>
}

/** An engine that does nothing, for tests and for running with no audio backend available. */
export class NullEngine implements PlaybackEngine {
  private listeners = new Set<EngineListener>()
  state: EngineState = 'idle'
  uri: string | null = null
  positionMs = 0
  volume = 100
  readonly loaded: string[] = []
  readonly preloaded: string[] = []

  private emit: EngineListener = (event, payload) => {
    for (const l of this.listeners) l(event, payload)
  }

  async load(uri: string): Promise<void> {
    this.uri = uri
    this.loaded.push(uri)
    this.positionMs = 0
    this.state = 'loading'
    this.emit('state', { state: 'loading' })
  }

  async play(): Promise<void> {
    this.state = 'playing'
    this.emit('state', { state: 'playing' })
  }

  async pause(): Promise<void> {
    this.state = 'paused'
    this.emit('state', { state: 'paused' })
  }

  async stop(): Promise<void> {
    this.state = 'idle'
    this.uri = null
    this.emit('state', { state: 'idle' })
  }

  async seek(positionMs: number): Promise<void> {
    this.positionMs = positionMs
    this.emit('position', { positionMs, durationMs: null })
  }

  async setVolume(volume: number): Promise<void> {
    this.volume = volume
  }

  async preload(uri: string): Promise<void> {
    this.preloaded.push(uri)
  }

  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async dispose(): Promise<void> {
    this.listeners.clear()
  }

  // ── test helpers ────────────────────────────────────────────────────────
  tick(positionMs: number, durationMs: number | null = 200_000): void {
    this.positionMs = positionMs
    this.emit('position', { positionMs, durationMs })
  }

  finish(): void {
    this.state = 'ended'
    this.emit('ended', {})
  }

  fail(message: string): void {
    this.state = 'error'
    this.emit('state', { state: 'error', error: message })
  }
}
