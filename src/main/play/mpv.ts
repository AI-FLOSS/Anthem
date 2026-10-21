// mpv backend, driven over its JSON IPC socket.
//
// mpv is used for the same reason gmusicbrowser eventually added an mpv backend: gapless, format
// coverage, precise seeking and output backend selection are unglamorous and enormous to re-solve,
// and mpv has already solved them. X-Music talks to it as a subprocess rather than linking libmpv,
// which keeps the native dependency surface at zero.

import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { EngineListener, EngineState, LoadOptions, PlaybackEngine } from './engine'

/** Finds an mpv binary: an explicit setting, then PATH, then a Nix store path. */
export function findMpv(explicit?: string): string | null {
  if (explicit && existsSync(explicit)) return explicit
  if (process.env.X_MUSIC_MPV && existsSync(process.env.X_MUSIC_MPV)) return process.env.X_MUSIC_MPV

  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue
    const candidate = join(dir, 'mpv')
    if (existsSync(candidate)) return candidate
  }
  return null
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

/** Unique per engine instance: two engines in one process must not share an IPC socket. */
let instanceCounter = 0

const PROP_POSITION = 1
const PROP_DURATION = 2
const PROP_PAUSE = 3
const PROP_IDLE = 4

export interface MpvOptions {
  binary?: string
  /** Receives mpv's own diagnostics, which are otherwise discarded. */
  onLog?: (line: string) => void
  /** How often mpv reports position, in seconds. The UI interpolates between ticks. */
  positionInterval?: number
  extraArgs?: readonly string[]
}

export class MpvEngine implements PlaybackEngine {
  private proc: ChildProcess | null = null
  private socket: Socket | null = null
  private readonly socketPath: string
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  private listeners = new Set<EngineListener>()

  private state: EngineState = 'idle'
  private positionMs = 0
  private durationMs: number | null = null
  private ready: Promise<void>
  /** Set while a load is in flight, so mpv going idle mid-swap is not read as the track ending. */
  private swapping = false

  constructor(private readonly opts: MpvOptions = {}) {
    this.socketPath = join(tmpdir(), `x-music-mpv-${process.pid}-${++instanceCounter}.sock`)
    // A leftover socket file stops mpv binding, so clear it before starting.
    rmSync(this.socketPath, { force: true })
    this.ready = this.start().catch((err: Error) => {
      this.setState('error', err.message)
      throw err
    })
  }

  private emit: EngineListener = (event, payload) => {
    for (const l of this.listeners) l(event, payload)
  }

  private setState(state: EngineState, error?: string): void {
    if (this.state === state && !error) return
    this.state = state
    this.emit('state', error ? { state, error } : { state })
  }

  private async start(): Promise<void> {
    const binary = findMpv(this.opts.binary)
    if (!binary) throw new Error('mpv was not found; set X_MUSIC_MPV or install mpv')

    this.proc = spawn(binary, [
      '--idle=yes',
      '--no-video',
      '--gapless-audio=yes',
      '--keep-open=no',
      '--audio-display=no',
      // Without this mpv's diagnostics go nowhere, which makes a failed load unexplainable.
      '--msg-level=all=warn',
      `--input-ipc-server=${this.socketPath}`,
      ...(this.opts.extraArgs ?? [])
    ], { stdio: ['ignore', 'ignore', 'pipe'] })

    this.proc.stderr?.setEncoding('utf8')
    this.proc.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') this.opts.onLog?.(line.trim())
      }
    })

    this.proc.on('exit', (code) => {
      this.socket = null
      if (code !== 0 && code !== null) this.setState('error', `mpv exited with code ${code}`)
    })

    await this.connect()
    await this.observe()
  }

  /** mpv creates the socket a moment after starting, so connecting is a short retry loop. */
  private connect(attempt = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath)

      socket.on('connect', () => {
        this.socket = socket
        socket.setEncoding('utf8')
        socket.on('data', (chunk: string) => this.onData(chunk))
        socket.on('error', () => { this.socket = null })
        resolve()
      })

      socket.on('error', () => {
        if (attempt >= 50) {
          reject(new Error('could not connect to mpv'))
          return
        }
        setTimeout(() => this.connect(attempt + 1).then(resolve, reject), 40)
      })
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk

    let index: number
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line === '') continue

      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue // A malformed line must not stall the stream.
      }

      if (typeof message.request_id === 'number') {
        const waiter = this.pending.get(message.request_id)
        if (waiter) {
          this.pending.delete(message.request_id)
          if (message.error === 'success') waiter.resolve(message.data)
          else waiter.reject(new Error(String(message.error)))
        }
        continue
      }

      this.onEvent(message)
    }
  }

  private onEvent(message: Record<string, unknown>): void {
    if (message.event === 'property-change') {
      const id = message.id as number
      const value = message.data

      if (id === PROP_POSITION && typeof value === 'number') {
        this.positionMs = Math.round(value * 1000)
        this.emit('position', { positionMs: this.positionMs, durationMs: this.durationMs })
      } else if (id === PROP_DURATION) {
        this.durationMs = typeof value === 'number' ? Math.round(value * 1000) : null
      } else if (id === PROP_PAUSE && typeof value === 'boolean') {
        if (this.state === 'playing' || this.state === 'paused') {
          this.setState(value ? 'paused' : 'playing')
        }
      } else if (id === PROP_IDLE && value === true && !this.swapping) {
        // mpv goes idle when its playlist runs out, which is how a finished track reports itself.
        if (this.state === 'playing' || this.state === 'paused') {
          this.setState('ended')
          this.emit('ended', {})
        }
      }
      return
    }

    if (message.event === 'end-file' && message.reason === 'error') {
      const detail = String(message.file_error ?? 'playback failed')
      this.opts.onLog?.(`end-file error: ${JSON.stringify(message)}`)
      this.setState('error', detail)
    }
  }

  /**
   * Writes a command straight to the socket. Used during start-up, where waiting on `ready` would
   * deadlock: `ready` is the promise that start-up itself resolves.
   */
  private send(...args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('mpv is not connected'))
        return
      }
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      this.socket.write(`${JSON.stringify({ command: args, request_id: id })}\n`)
    })
  }

  /** Waits for start-up before sending, for everything after it. */
  private command(...args: unknown[]): Promise<unknown> {
    return this.ready.then(() => this.send(...args))
  }

  private async observe(): Promise<void> {
    const interval = this.opts.positionInterval ?? 0.25
    await this.send('observe_property', PROP_POSITION, 'time-pos')
    await this.send('observe_property', PROP_DURATION, 'duration')
    await this.send('observe_property', PROP_PAUSE, 'pause')
    await this.send('observe_property', PROP_IDLE, 'idle-active')
    // mpv reports time-pos on change; this keeps the cadence predictable for the UI.
    await this.send('set_property', 'options/audio-buffer', String(interval))
  }

  /**
   * mpv 0.38 added an insert-index parameter to loadfile, so the signature is
   * `loadfile <url> <flags> <index> <options>`. Passing options in the index slot fails with
   * "invalid parameter", and an empty options string is rejected outright — so the argument list
   * is built rather than padded.
   */
  private loadArgs(uri: string, mode: 'replace' | 'append', opts?: LoadOptions): unknown[] {
    const flags = this.applyOptions(opts)
    return flags.length > 0
      ? ['loadfile', uri, mode, -1, flags.join(',')]
      : ['loadfile', uri, mode]
  }

  private applyOptions(opts?: LoadOptions): string[] {
    const flags: string[] = []
    if (opts?.startMs != null) flags.push(`start=${(opts.startMs / 1000).toFixed(3)}`)
    if (opts?.endMs != null) flags.push(`end=${(opts.endMs / 1000).toFixed(3)}`)
    // ReplayGain is applied as a volume adjustment rather than by re-encoding anything.
    if (opts?.gainDb != null) {
      const factor = Math.pow(10, opts.gainDb / 20)
      flags.push(`af-add=volume=${factor.toFixed(4)}`)
    }
    return flags
  }

  async load(uri: string, opts?: LoadOptions): Promise<void> {
    this.swapping = true
    this.setState('loading')
    this.positionMs = 0
    this.durationMs = null

    try {
      await this.command(...this.loadArgs(uri, 'replace', opts))
      await this.command('set_property', 'pause', false)
      this.setState('playing')
    } finally {
      this.swapping = false
    }
  }

  async preload(uri: string, opts?: LoadOptions): Promise<void> {
    // Appending puts the next file in mpv's own playlist, which is what makes the join gapless.
    await this.command(...this.loadArgs(uri, 'append', opts))
  }

  async play(): Promise<void> {
    await this.command('set_property', 'pause', false)
    this.setState('playing')
  }

  async pause(): Promise<void> {
    await this.command('set_property', 'pause', true)
    this.setState('paused')
  }

  async stop(): Promise<void> {
    this.swapping = true
    try {
      await this.command('stop')
      this.setState('idle')
    } finally {
      this.swapping = false
    }
  }

  async seek(positionMs: number): Promise<void> {
    await this.command('seek', positionMs / 1000, 'absolute')
    this.positionMs = positionMs
  }

  async setVolume(volume: number): Promise<void> {
    await this.command('set_property', 'volume', volume)
  }

  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async dispose(): Promise<void> {
    this.listeners.clear()
    try {
      await this.command('quit')
    } catch {
      // Already gone; killing below is the fallback.
    }
    this.socket?.destroy()
    this.proc?.kill()
    this.proc = null
    this.socket = null
    rmSync(this.socketPath, { force: true })
  }
}
