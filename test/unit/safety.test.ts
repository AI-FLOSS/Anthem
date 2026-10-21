// Read-only mode is the promise that lets someone point X-Music at an irreplaceable music library.
// These tests exist so the promise is checked rather than assumed.

import { describe, expect, it, beforeEach } from 'vitest'
import {
  ReadOnlyError, assertWritable, canWrite, initSafety, isReadOnly, safetyStatus, setReadOnly
} from '@main/safety'

beforeEach(() => {
  delete process.env.X_MUSIC_FORCE_READ_ONLY
  initSafety(['/home/u/.config/x-music'])
  setReadOnly(true)
})

describe('read-only mode', () => {
  it('is on by default', () => {
    expect(isReadOnly()).toBe(true)
  })

  it('refuses every mutating operation on library files', () => {
    const ops = ['tag-write', 'file-rename', 'file-move', 'file-delete', 'artwork-embed'] as const
    for (const op of ops) {
      expect(() => assertWritable(op, '/music/album/01.flac')).toThrow(ReadOnlyError)
    }
  })

  it('names the operation and the path it refused', () => {
    try {
      assertWritable('tag-write', '/music/x.flac')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ReadOnlyError)
      expect((err as ReadOnlyError).operation).toBe('tag-write')
      expect((err as ReadOnlyError).path).toBe('/music/x.flac')
    }
  })

  it('still allows X-Music to maintain its own database', () => {
    expect(() => assertWritable('playlist-write', '/home/u/.config/x-music/library.db')).not.toThrow()
    expect(() => assertWritable('playlist-write', '/home/u/.config/x-music/art/ab.webp')).not.toThrow()
  })

  it('does not treat a sibling directory as its own data directory', () => {
    // A prefix match without a separator check would wrongly allow this.
    expect(() => assertWritable('file-delete', '/home/u/.config/x-music-backup/x')).toThrow(ReadOnlyError)
  })

  it('permits library writes once explicitly disabled', () => {
    setReadOnly(false)
    expect(() => assertWritable('tag-write', '/music/x.flac')).not.toThrow()
    expect(canWrite('/music/x.flac')).toBe(true)
  })

  it('cannot be disabled when pinned by the environment', () => {
    process.env.X_MUSIC_FORCE_READ_ONLY = '1'
    expect(() => setReadOnly(false)).toThrow(/pinned/)
    expect(isReadOnly()).toBe(true)
  })

  it('reports a status the UI can display without guessing', () => {
    expect(safetyStatus().readOnly).toBe(true)
    expect(safetyStatus().reason).toMatch(/will not modify/)
    process.env.X_MUSIC_FORCE_READ_ONLY = '1'
    expect(safetyStatus().pinned).toBe(true)
  })
})
