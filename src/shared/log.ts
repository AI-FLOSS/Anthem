// Logging.
//
// The level filter is parsed here, apart from any transport, because the interesting behaviour is
// what a malformed or partial specification does — and that deserves a test rather than a guess.
// A bad X_MUSIC_LOG must never silence logging or crash start-up; it falls back to the default.

export type Level = 'critical' | 'error' | 'warn' | 'info' | 'debug'

const ORDER: Record<Level, number> = {
  critical: 0, error: 1, warn: 2, info: 3, debug: 4
}

export const LEVELS = Object.keys(ORDER) as Level[]

const ALIASES: Record<string, Level> = {
  crit: 'critical', critical: 'critical',
  err: 'error', error: 'error',
  warn: 'warn', warning: 'warn',
  info: 'info',
  debug: 'debug', verbose: 'debug', trace: 'debug'
}

export const DEFAULT_LEVEL: Level = 'info'

export interface LevelSpec {
  /** Applies to any scope without its own entry. */
  default: Level
  scopes: Record<string, Level>
}

/**
 * Parses a specification like `info`, `debug`, or `warn,play:debug,db:error`.
 *
 * A bare level sets the default; `scope:level` overrides one scope. Unrecognised entries are
 * ignored rather than rejected, so one typo does not turn logging off.
 */
export function parseLevelSpec(spec: string | undefined, fallback: Level = DEFAULT_LEVEL): LevelSpec {
  const out: LevelSpec = { default: fallback, scopes: {} }
  if (!spec) return out

  for (const partRaw of spec.split(',')) {
    const part = partRaw.trim().toLowerCase()
    if (part === '') continue

    // Split on the LAST colon: scopes are themselves colon-separated, so `ui:songlist:debug`
    // names the scope `ui:songlist` at level `debug`, not a scope `ui` at level `songlist:debug`.
    const colon = part.lastIndexOf(':')
    if (colon === -1) {
      const level = ALIASES[part]
      if (level) out.default = level
      continue
    }

    const scope = part.slice(0, colon).trim()
    const level = ALIASES[part.slice(colon + 1).trim()]
    if (!level || scope === '') continue

    if (scope === '*') out.default = level
    else out.scopes[scope] = level
  }

  return out
}

export const levelFor = (spec: LevelSpec, scope: string): Level =>
  spec.scopes[scope] ?? spec.default

export const enabled = (spec: LevelSpec, scope: string, level: Level): boolean =>
  ORDER[level] <= ORDER[levelFor(spec, scope)]

export interface LogRecord {
  at: number
  level: Level
  scope: string
  message: string
  /** Structured detail, appended as JSON when present. */
  data?: unknown
}

export type Sink = (record: LogRecord) => void

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** `10:33:35.123 WARN  play  message {"detail":1}` — fixed columns, so a log is scannable. */
export function formatRecord(r: LogRecord): string {
  const d = new Date(r.at)
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `.${String(d.getMilliseconds()).padStart(3, '0')}`

  let line = `${time} ${r.level.toUpperCase().padEnd(8)} ${r.scope.padEnd(9)} ${r.message}`
  if (r.data !== undefined) {
    try {
      line += ` ${JSON.stringify(r.data)}`
    } catch {
      line += ' [unserializable]'
    }
  }
  return line
}

export interface Logger {
  critical(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  debug(message: string, data?: unknown): void
  /** Whether a level would be emitted, for skipping expensive message building. */
  enabled(level: Level): boolean
  child(scope: string): Logger
}

/**
 * The spec may be a function, which matters where configuration arrives after the first logger is
 * made — the renderer learns its level from the main process, and a logger created at module load
 * would otherwise be stuck with the default forever.
 */
export type SpecSource = LevelSpec | (() => LevelSpec)

const resolve = (source: SpecSource): LevelSpec =>
  typeof source === 'function' ? source() : source

export function createLogger(scope: string, spec: SpecSource, sink: Sink): Logger {
  const emit = (level: Level, message: string, data?: unknown): void => {
    if (!enabled(resolve(spec), scope, level)) return
    sink({ at: Date.now(), level, scope, message, data })
  }

  return {
    critical: (m, d) => emit('critical', m, d),
    error: (m, d) => emit('error', m, d),
    warn: (m, d) => emit('warn', m, d),
    info: (m, d) => emit('info', m, d),
    debug: (m, d) => emit('debug', m, d),
    enabled: (level) => enabled(resolve(spec), scope, level),
    child: (sub) => createLogger(`${scope}:${sub}`, spec, sink)
  }
}
