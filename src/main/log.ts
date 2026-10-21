// The main process's logger.
//
// Configured entirely by environment, so a user reporting a problem can turn on detail without a
// rebuild: X_MUSIC_LOG=debug, or X_MUSIC_LOG=warn,play:debug to make one area noisy while the rest
// stays quiet. X_MUSIC_LOG_FILE additionally appends to a file.

import { appendFileSync } from 'node:fs'
import {
  createLogger, formatRecord, parseLevelSpec, type Level, type Logger, type LogRecord
} from '@shared/log'

const spec = parseLevelSpec(process.env.X_MUSIC_LOG)
const file = process.env.X_MUSIC_LOG_FILE

const toConsole = (record: LogRecord): void => {
  const line = formatRecord(record)
  // Warnings and worse go to stderr so they survive stdout redirection.
  if (record.level === 'info' || record.level === 'debug') console.log(line)
  else console.error(line)
}

const sink = (record: LogRecord): void => {
  toConsole(record)
  if (!file) return
  try {
    appendFileSync(file, `${formatRecord(record)}\n`)
  } catch {
    // A log that cannot be written must not take the app down with it.
  }
}

export const log = createLogger('app', spec, sink)

export const logger = (scope: string): Logger => createLogger(scope, spec, sink)

/** Records arriving from the renderer, already levelled and scoped there. */
export function logFromRenderer(level: Level, scope: string, message: string, data?: unknown): void {
  createLogger(`ui:${scope}`, spec, sink)[level](message, data)
}

export const describeLogging = (): string =>
  `level=${spec.default}` +
  (Object.keys(spec.scopes).length ? ` scopes=${JSON.stringify(spec.scopes)}` : '') +
  (file ? ` file=${file}` : '')
