// SQLite is the source of truth for the library: what music the user has, what it is called, and
// what they have done with it. Files are evidence, not authority (DESIGN-SPEC §3).

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

import initial from './migrations/001-initial.sql?raw'
import historyUnique from './migrations/002-history-unique.sql?raw'
import mergeJournal from './migrations/003-merge-journal.sql?raw'
import artwork from './migrations/004-artwork.sql?raw'

export type DB = Database.Database

const MIGRATIONS: readonly { version: number; sql: string }[] = [
  { version: 1, sql: initial },
  { version: 2, sql: historyUnique },
  { version: 3, sql: mergeJournal },
  { version: 4, sql: artwork }
]

export function libraryPath(): string {
  return process.env.X_MUSIC_DB ?? join(app.getPath('userData'), 'library.db')
}

function applyPragmas(db: DB): void {
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('temp_store = MEMORY')
  db.pragma('mmap_size = 268435456')
  db.pragma('cache_size = -65536')
}

function migrate(db: DB): number {
  const current = db.pragma('user_version', { simple: true }) as number

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    db.exec('BEGIN')
    try {
      db.exec(m.sql)
      db.pragma(`user_version = ${m.version}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`migration ${m.version} failed: ${(err as Error).message}`)
    }
  }

  return db.pragma('user_version', { simple: true }) as number
}

export function openLibrary(path = libraryPath()): DB {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  applyPragmas(db)

  // The filter AST compiles `regex` to REGEXP, which SQLite leaves to the host to define.
  db.function('REGEXP', { deterministic: true }, (pattern: unknown, value: unknown) => {
    if (value === null || value === undefined) return 0
    try {
      return new RegExp(String(pattern), 'u').test(String(value)) ? 1 : 0
    } catch {
      return 0
    }
  })

  migrate(db)
  return db
}

export interface LibraryStats {
  tracks: number
  media: number
  albums: number
  missing: number
  totalMs: number
  schemaVersion: number
  path: string
}

export function stats(db: DB, path = libraryPath()): LibraryStats {
  const one = <T>(sql: string): T => db.prepare(sql).pluck().get() as T
  return {
    tracks: one<number>('SELECT COUNT(*) FROM tracks'),
    media: one<number>('SELECT COUNT(*) FROM media'),
    albums: one<number>('SELECT COUNT(*) FROM albums'),
    missing: one<number>('SELECT COUNT(*) FROM media WHERE present = 0'),
    totalMs: one<number>('SELECT COALESCE(SUM(length_ms), 0) FROM tracks'),
    schemaVersion: db.pragma('user_version', { simple: true }) as number,
    path
  }
}
