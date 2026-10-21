// What plays, and what plays next.
//
// This owns every decision X-Music makes about playback and none of the audio: which of a track's
// media to use, when a play counts as a play rather than a skip, how the queue drains against the
// standing playlist, and what repeat and shuffle mean. The engine underneath is injected, so all of
// it is testable without spawning a process.

import { existsSync } from 'node:fs'

import type { LoadOptions, PlaybackEngine } from './engine'
import type { Db } from '../library/identity'

export type RepeatMode = 'off' | 'all' | 'one'

export interface PlayerTrack {
  id: number
  title: string | null
  artist: string | null
  album: string | null
  lengthMs: number | null
  rating: number | null
}

export interface PlayerMedia {
  id: number
  uri: string
  startMs: number | null
  endMs: number | null
  gainDb: number | null
}

export interface PlayerStatus {
  state: 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'
  track: PlayerTrack | null
  media: PlayerMedia | null
  positionMs: number
  durationMs: number | null
  volume: number
  repeat: RepeatMode
  shuffle: boolean
  /** Tracks explicitly queued, which drain before the standing context. */
  queue: number[]
  /** The list the player walks when the queue is empty. */
  contextLength: number
  contextIndex: number
  error?: string
}

export interface PlayerEvents {
  status: PlayerStatus
  position: { positionMs: number; durationMs: number | null }
}

export type PlayerListener = <E extends keyof PlayerEvents>(
  event: E,
  payload: PlayerEvents[E]
) => void

/**
 * A play counts once the listener has heard enough of it to mean it. Anything less that is skipped
 * forward counts as a skip. These are the conventional thresholds and they matter, because play
 * counts drive weighted shuffle and smart playlists.
 */
export const PLAY_THRESHOLD_RATIO = 0.5
export const PLAY_THRESHOLD_MS = 240_000

export function countsAsPlay(positionMs: number, durationMs: number | null): boolean {
  if (positionMs >= PLAY_THRESHOLD_MS) return true
  if (durationMs === null || durationMs <= 0) return false
  return positionMs / durationMs >= PLAY_THRESHOLD_RATIO
}

/** Deterministic shuffle, so an order can be reproduced and tested. */
export function shuffleOrder(length: number, seed: number): number[] {
  const order = Array.from({ length }, (_, i) => i)
  let s = seed | 0 || 1
  for (let i = length - 1; i > 0; i--) {
    s ^= s << 13; s |= 0
    s ^= s >>> 17
    s ^= s << 5; s |= 0
    const j = Math.abs(s) % (i + 1)
    ;[order[i], order[j]] = [order[j]!, order[i]!]
  }
  return order
}

const TRACK_SELECT = `
  t.id, t.title, t.length_ms AS lengthMs, t.rating,
  (SELECT a.name FROM albums a WHERE a.id = t.album_id) AS album,
  (SELECT vv.value FROM track_values tv JOIN values_ vv ON vv.id = tv.value_id
    WHERE tv.track_id = t.id AND tv.field_id = 1 ORDER BY tv.ordinal LIMIT 1) AS artist`

export interface PlayerOptions {
  /** How ReplayGain is applied; 'off' leaves the file alone. */
  replayGain?: 'off' | 'track' | 'album'
  preampDb?: number
}

export class Player {
  private listeners = new Set<PlayerListener>()
  private unsubscribe: (() => void) | null = null

  private context: number[] = []
  private contextIndex = -1
  private order: number[] | null = null
  private queue: number[] = []

  private currentTrack: PlayerTrack | null = null
  private currentMedia: PlayerMedia | null = null
  private state: PlayerStatus['state'] = 'idle'
  private positionMs = 0
  private durationMs: number | null = null
  private volume = 80
  private error: string | undefined

  repeat: RepeatMode = 'off'
  shuffle = false

  /** Highest position reached in the current track, so a seek back cannot fake a play. */
  private furthestMs = 0
  /** A track resolves to exactly one outcome: played, skipped, or neither. Never both. */
  private settled = false
  private seed = 1

  constructor(
    private readonly db: Db,
    private readonly engine: PlaybackEngine,
    private readonly opts: PlayerOptions = {}
  ) {
    this.unsubscribe = engine.subscribe((event, payload) => {
      if (event === 'position') {
        const p = payload as PlayerEvents['position']
        this.positionMs = p.positionMs
        this.durationMs = p.durationMs ?? this.durationMs
        this.furthestMs = Math.max(this.furthestMs, p.positionMs)
        this.maybeCountPlay()
        this.emit('position', { positionMs: this.positionMs, durationMs: this.durationMs })
      } else if (event === 'state') {
        const s = payload as { state: PlayerStatus['state']; error?: string }
        this.state = s.state
        this.error = s.error
        this.publish()
      } else if (event === 'ended') {
        void this.onEnded()
      }
    })
  }

  // ── data access ────────────────────────────────────────────────────────
  private loadTrack(id: number): PlayerTrack | null {
    return (this.db.prepare(`SELECT ${TRACK_SELECT} FROM tracks t WHERE t.id = ?`)
      .get(id as never) ?? null) as PlayerTrack | null
  }

  /**
   * The best source that is actually there.
   *
   * Existence is checked rather than trusted: a library imported from elsewhere, or scanned before
   * a drive was unplugged, is full of rows whose files have since gone. Handing one of those to the
   * engine produces "loading failed", which tells the listener nothing. A row found to be absent is
   * marked so, which also means the library corrects itself as it is used.
   */
  private loadMedia(trackId: number): PlayerMedia | null {
    const rows = this.db.prepare(`
      SELECT m.id, m.uri, m.present, m.start_ms AS startMs, m.end_ms AS endMs,
             t.rg_track_gain AS trackGain, t.rg_album_gain AS albumGain
      FROM media m JOIN tracks t ON t.id = m.track_id
      WHERE m.track_id = ? AND m.kind = 'file'
      ORDER BY m.present DESC, m.quality_rank DESC, m.id`).all(trackId as never) as
      { id: number; uri: string; present: number; startMs: number | null; endMs: number | null
        trackGain: number | null; albumGain: number | null }[]

    const mode = this.opts.replayGain ?? 'off'

    for (const row of rows) {
      if (!existsSync(row.uri)) {
        if (row.present === 1) {
          this.db.prepare('UPDATE media SET present = 0 WHERE id = ?').run(row.id as never)
        }
        continue
      }

      // Found on disk after being marked absent: the drive came back, so record that.
      if (row.present === 0) {
        this.db.prepare('UPDATE media SET present = 1 WHERE id = ?').run(row.id as never)
      }

      const gain = mode === 'track' ? row.trackGain : mode === 'album' ? row.albumGain : null
      return {
        id: row.id,
        uri: row.uri,
        startMs: row.startMs,
        endMs: row.endMs,
        gainDb: gain === null ? null : gain + (this.opts.preampDb ?? 0)
      }
    }

    return null
  }

  /** Whether a track has any file on disk, without loading it. */
  private hasAnyMedia(trackId: number): boolean {
    return ((this.db.prepare(
      `SELECT COUNT(*) AS n FROM media WHERE track_id = ? AND kind = 'file'`)
      .get(trackId as never) as { n: number }).n) > 0
  }

  // ── statistics ─────────────────────────────────────────────────────────
  private maybeCountPlay(): void {
    if (this.settled || !this.currentTrack) return
    if (!countsAsPlay(this.furthestMs, this.durationMs ?? this.currentTrack.lengthMs)) return

    this.settled = true
    const now = Date.now()
    this.db.prepare(`
      UPDATE tracks SET play_count = play_count + 1, last_played = ?,
                        first_played = COALESCE(first_played, ?)
      WHERE id = ?`).run(now as never, now as never, this.currentTrack.id as never)
    this.db.prepare('INSERT OR IGNORE INTO play_history (track_id, at, kind) VALUES (?, ?, 0)')
      .run(this.currentTrack.id as never, now as never)
  }

  /** Called when a track is abandoned before it counted as played. */
  private recordSkip(): void {
    if (this.settled || !this.currentTrack) return
    // Barely-started tracks are not skips; the listener changed their mind before it began.
    if (this.furthestMs < 3000) return

    this.settled = true
    const now = Date.now()
    this.db.prepare(
      'UPDATE tracks SET skip_count = skip_count + 1, last_skipped = ? WHERE id = ?')
      .run(now as never, this.currentTrack.id as never)
    this.db.prepare('INSERT OR IGNORE INTO play_history (track_id, at, kind) VALUES (?, ?, 1)')
      .run(this.currentTrack.id as never, now as never)
  }

  // ── ordering ───────────────────────────────────────────────────────────
  private rebuildOrder(): void {
    this.order = this.shuffle ? shuffleOrder(this.context.length, this.seed) : null
  }

  /** Position of `contextIndex` within the walk order. */
  private orderPosition(): number {
    if (!this.order) return this.contextIndex
    return this.order.indexOf(this.contextIndex)
  }

  private contextAt(orderPos: number): number | null {
    if (orderPos < 0 || orderPos >= this.context.length) return null
    const idx = this.order ? this.order[orderPos]! : orderPos
    return this.context[idx] ?? null
  }

  private nextFromContext(step: 1 | -1): { trackId: number; index: number } | null {
    if (this.context.length === 0) return null

    const pos = this.orderPosition()
    let nextPos = pos + step

    if (nextPos >= this.context.length || nextPos < 0) {
      if (this.repeat !== 'all') return null
      nextPos = step === 1 ? 0 : this.context.length - 1
      // A new pass through a shuffled list should not repeat the same order.
      if (this.shuffle) { this.seed = (this.seed * 1103515245 + 12345) | 0; this.rebuildOrder() }
    }

    const trackId = this.contextAt(nextPos)
    if (trackId === null) return null

    const index = this.order ? this.order[nextPos]! : nextPos
    return { trackId, index }
  }

  // ── commands ───────────────────────────────────────────────────────────
  setContext(trackIds: readonly number[], startIndex = -1): void {
    this.context = [...trackIds]
    this.contextIndex = startIndex
    this.rebuildOrder()
    this.publish()
  }

  enqueue(trackIds: readonly number[], position: 'end' | 'next' = 'end'): void {
    this.queue = position === 'next'
      ? [...trackIds, ...this.queue]
      : [...this.queue, ...trackIds]
    this.publish()
  }

  dequeue(index: number): void {
    this.queue = this.queue.filter((_, i) => i !== index)
    this.publish()
  }

  clearQueue(): void {
    this.queue = []
    this.publish()
  }

  async playTrack(trackId: number, contextIndex = -1): Promise<void> {
    this.recordSkip()

    const track = this.loadTrack(trackId)
    if (!track) throw new Error(`track ${trackId} no longer exists`)

    const media = this.loadMedia(trackId)
    if (!media) {
      this.currentTrack = track
      this.currentMedia = null
      this.state = 'error'
      // Distinguish "never had a file" from "the file is gone", because the fix differs.
      this.error = this.hasAnyMedia(trackId)
        ? 'The file for this track is missing. Rescan its folder, or reconnect the drive it is on.'
        : 'This track has no file. It exists in the library, but nothing is attached to it.'
      this.publish()
      return
    }

    this.currentTrack = track
    this.currentMedia = media
    this.positionMs = 0
    this.furthestMs = 0
    this.settled = false
    this.durationMs = track.lengthMs
    this.error = undefined
    if (contextIndex >= 0) this.contextIndex = contextIndex

    const opts: LoadOptions = {
      startMs: media.startMs, endMs: media.endMs, gainDb: media.gainDb
    }

    await this.engine.load(media.uri, opts)
    await this.engine.play()
    this.publish()
    void this.preloadNext()
  }

  /** Tells the engine what is coming, so it can make the transition gapless. */
  private async preloadNext(): Promise<void> {
    if (!this.engine.preload) return
    const upcoming = this.peekNext()
    if (upcoming === null) return

    const media = this.loadMedia(upcoming)
    if (!media) return
    await this.engine.preload(media.uri, {
      startMs: media.startMs, endMs: media.endMs, gainDb: media.gainDb
    })
  }

  peekNext(): number | null {
    if (this.queue.length > 0) return this.queue[0]!
    if (this.repeat === 'one' && this.currentTrack) return this.currentTrack.id
    return this.nextFromContext(1)?.trackId ?? null
  }

  async next(userInitiated = true): Promise<void> {
    if (userInitiated) this.recordSkip()

    if (this.queue.length > 0) {
      const [head, ...rest] = this.queue
      this.queue = rest
      await this.playTrack(head!)
      return
    }

    if (this.repeat === 'one' && this.currentTrack && !userInitiated) {
      await this.playTrack(this.currentTrack.id)
      return
    }

    const target = this.nextFromContext(1)
    if (!target) {
      await this.stop()
      return
    }
    await this.playTrack(target.trackId, target.index)
  }

  async previous(): Promise<void> {
    // Restart the track first, as every other player does, before stepping back.
    if (this.positionMs > 3000 && this.currentTrack) {
      await this.seek(0)
      return
    }

    this.recordSkip()
    const target = this.nextFromContext(-1)
    if (!target) {
      await this.seek(0)
      return
    }
    await this.playTrack(target.trackId, target.index)
  }

  private async onEnded(): Promise<void> {
    // Reaching the end is a complete listen even if the position tick missed the threshold.
    if (!this.settled && this.currentTrack) {
      this.furthestMs = this.durationMs ?? this.currentTrack.lengthMs ?? PLAY_THRESHOLD_MS
      this.maybeCountPlay()
    }
    await this.next(false)
  }

  async play(): Promise<void> {
    if (!this.currentTrack) {
      const first = this.queue[0] ?? this.contextAt(0)
      if (first === null || first === undefined) return
      await this.next(false)
      return
    }
    await this.engine.play()
  }

  async pause(): Promise<void> { await this.engine.pause() }

  async toggle(): Promise<void> {
    if (this.state === 'playing') await this.pause()
    else await this.play()
  }

  async stop(): Promise<void> {
    this.recordSkip()
    await this.engine.stop()
    this.currentTrack = null
    this.currentMedia = null
    this.positionMs = 0
    this.state = 'idle'
    this.publish()
  }

  async seek(positionMs: number): Promise<void> {
    await this.engine.seek(positionMs)
    this.positionMs = positionMs
  }

  async setVolume(volume: number): Promise<void> {
    this.volume = Math.max(0, Math.min(100, volume))
    await this.engine.setVolume(this.volume)
    this.publish()
  }

  setRepeat(mode: RepeatMode): void { this.repeat = mode; this.publish() }

  setShuffle(on: boolean): void {
    this.shuffle = on
    this.rebuildOrder()
    this.publish()
  }

  // ── observation ────────────────────────────────────────────────────────
  status(): PlayerStatus {
    return {
      state: this.state,
      track: this.currentTrack,
      media: this.currentMedia,
      positionMs: this.positionMs,
      durationMs: this.durationMs,
      volume: this.volume,
      repeat: this.repeat,
      shuffle: this.shuffle,
      queue: [...this.queue],
      contextLength: this.context.length,
      contextIndex: this.contextIndex,
      error: this.error
    }
  }

  subscribe(listener: PlayerListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit: PlayerListener = (event, payload) => {
    for (const l of this.listeners) l(event, payload)
  }

  private publish(): void {
    this.emit('status', this.status())
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.()
    this.listeners.clear()
    await this.engine.dispose()
  }
}
