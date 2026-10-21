// Copying the live library for a read-only test.
//
// The database runs in WAL mode, so recent changes — including a migration applied at the last
// launch — live in the -wal file rather than the main one. Copying only library.db silently yields
// an older schema, which looks like a missing table rather than a missing file.

import { copyFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const livePath = (): string => join(homedir(), '.config/x-music/library.db')

export const hasLiveLibrary = (): boolean => existsSync(livePath())

/** Copies the database and its write-ahead log, and returns the copy's path. */
export function copyLiveLibrary(name: string): string {
  const source = livePath()
  const target = join(tmpdir(), name)

  copyFileSync(source, target)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(source + suffix)) copyFileSync(source + suffix, target + suffix)
  }

  return target
}
