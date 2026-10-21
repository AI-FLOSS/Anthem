// Read-only mode. X-Music points at a music library that took years to assemble and that the user
// cannot easily reconstruct, so the default posture is that it never writes to it.
//
// This is enforced as a chokepoint rather than as a convention: every filesystem-mutating operation
// must pass through assertWritable(), and the only paths ever writable are X-Music's own data
// directory and whatever the user has explicitly unlocked. Tag writing, file organizing and
// deletion are all downstream of this function.

import { resolve, sep } from 'node:path'

export type WriteOperation =
  | 'tag-write' | 'file-rename' | 'file-move' | 'file-delete' | 'artwork-embed' | 'playlist-write'

export class ReadOnlyError extends Error {
  constructor(readonly operation: WriteOperation, readonly path: string) {
    super(`refused ${operation} on ${path}: X-Music is in read-only mode`)
    this.name = 'ReadOnlyError'
  }
}

interface SafetyState {
  readOnly: boolean
  /** Paths X-Music may always write to, regardless of mode: its own database and caches. */
  ownDataDirs: string[]
}

const state: SafetyState = {
  // Read-only unless explicitly disabled. A missing or malformed env var keeps protection on.
  readOnly: process.env.X_MUSIC_ALLOW_WRITES !== '1',
  ownDataDirs: []
}

export function initSafety(ownDataDirs: readonly string[]): void {
  state.ownDataDirs = ownDataDirs.map((d) => resolve(d))
}

export const isReadOnly = (): boolean => state.readOnly

/**
 * Leaves read-only mode. Deliberately awkward to reach: the UI must confirm, and the environment
 * must not have pinned the mode. There is no corresponding "turn it off quietly" path.
 */
export function setReadOnly(value: boolean): void {
  if (!value && process.env.X_MUSIC_FORCE_READ_ONLY === '1') {
    throw new Error('read-only mode is pinned by X_MUSIC_FORCE_READ_ONLY')
  }
  state.readOnly = value
}

function isOwnData(path: string): boolean {
  const p = resolve(path)
  return state.ownDataDirs.some((d) => p === d || p.startsWith(d + sep))
}

/**
 * The chokepoint. Throws unless the write is permitted. X-Music's own data directory is always
 * writable — otherwise the library database itself could not be maintained.
 */
export function assertWritable(operation: WriteOperation, path: string): void {
  if (isOwnData(path)) return
  if (state.readOnly) throw new ReadOnlyError(operation, path)
}

export const canWrite = (path: string): boolean => {
  try {
    assertWritable('tag-write', path)
    return true
  } catch {
    return false
  }
}

export interface SafetyStatus {
  readOnly: boolean
  pinned: boolean
  reason: string
}

export function safetyStatus(): SafetyStatus {
  const pinned = process.env.X_MUSIC_FORCE_READ_ONLY === '1'
  return {
    readOnly: state.readOnly,
    pinned,
    reason: pinned
      ? 'Pinned read-only by X_MUSIC_FORCE_READ_ONLY'
      : state.readOnly
        ? 'Read-only: X-Music will not modify any file in your library'
        : 'Writes enabled'
  }
}
