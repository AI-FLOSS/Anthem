// The scanner's contract: read only, never duplicate, recognise moved files, and flag rather than
// delete what has disappeared.

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, rename, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanRoots } from '@main/library/scan'
import { freshDb, type TestDb } from '../helpers/sqlite'

let dir: string
let db: TestDb

/** A tiny but genuinely parseable FLAC: signature, STREAMINFO with an md5, then padding. */
function flac(md5: string, audio: Buffer): Buffer {
  const streaminfo = Buffer.alloc(34)
  streaminfo.writeUInt16BE(4096, 0)
  streaminfo.writeUInt16BE(4096, 2)
  Buffer.from(md5, 'hex').copy(streaminfo, 18)
  return Buffer.concat([
    Buffer.from('fLaC'),
    Buffer.from([0x00, 0x00, 0x00, 0x22]), streaminfo,
    Buffer.from([0x81, 0x00, 0x00, 0x04]), Buffer.alloc(4),
    audio
  ])
}

const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n
const tracks = (): number => count('SELECT COUNT(*) AS n FROM tracks')
const media = (): number => count('SELECT COUNT(*) AS n FROM media')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'x-music-scan-'))
  db = freshDb()
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('scanning', () => {
  it('indexes audio files and ignores everything else', async () => {
    await writeFile(join(dir, 'a.flac'), flac('0'.repeat(31) + '1', Buffer.alloc(512, 1)))
    await writeFile(join(dir, 'notes.txt'), 'not music')
    await writeFile(join(dir, 'cover.jpg'), Buffer.alloc(64))

    const report = await scanRoots(db as never, [dir])
    expect(report.filesFound).toBe(1)
    expect(tracks()).toBe(1)
    expect(media()).toBe(1)
  })

  it('descends into subdirectories', async () => {
    await mkdir(join(dir, 'album'), { recursive: true })
    await writeFile(join(dir, 'album', 'one.flac'), flac('0'.repeat(31) + '2', Buffer.alloc(512, 2)))
    const report = await scanRoots(db as never, [dir])
    expect(report.filesFound).toBe(1)
  })

  it('is idempotent: a second scan creates nothing', async () => {
    await writeFile(join(dir, 'a.flac'), flac('0'.repeat(31) + '3', Buffer.alloc(512, 3)))
    await scanRoots(db as never, [dir])
    const before = { t: tracks(), m: media() }

    const second = await scanRoots(db as never, [dir])
    expect({ t: tracks(), m: media() }).toEqual(before)
    // The unchanged file takes the cheap path rather than being re-read.
    expect(second.filesSkipped).toBe(1)
    expect(second.filesRead).toBe(0)
  })

  it('rehashes an unchanged file that has no hash yet, as imported rows do', async () => {
    await writeFile(join(dir, 'a.flac'), flac('0'.repeat(31) + '4', Buffer.alloc(512, 4)))
    await scanRoots(db as never, [dir])
    db.exec('UPDATE media SET audio_hash = NULL, audio_hash_algo = NULL')

    const second = await scanRoots(db as never, [dir])
    expect(second.filesRead).toBe(1)
    expect(count('SELECT COUNT(*) AS n FROM media WHERE audio_hash IS NOT NULL')).toBe(1)

    const third = await scanRoots(db as never, [dir])
    expect(third.filesSkipped).toBe(1)
  })

  it('recognises a renamed file as the same track, keeping its rating', async () => {
    const md5 = 'a'.repeat(32)
    await writeFile(join(dir, 'before.flac'), flac(md5, Buffer.alloc(512, 4)))
    await scanRoots(db as never, [dir])

    db.prepare('UPDATE tracks SET rating = 100, play_count = 7').run()
    await rename(join(dir, 'before.flac'), join(dir, 'after.flac'))

    const report = await scanRoots(db as never, [dir])
    expect(report.movesDetected).toBe(1)
    expect(tracks()).toBe(1)
    expect(media()).toBe(1)

    const t = db.prepare('SELECT rating, play_count FROM tracks').get() as
      { rating: number; play_count: number }
    expect(t).toEqual({ rating: 100, play_count: 7 })

    const m = db.prepare('SELECT uri, present FROM media').get() as
      { uri: string; present: number }
    expect(m.uri).toBe(join(dir, 'after.flac'))
    expect(m.present).toBe(1)
  })

  it('flags a deleted file as missing without losing the track', async () => {
    await writeFile(join(dir, 'gone.flac'), flac('b'.repeat(32), Buffer.alloc(512, 5)))
    await scanRoots(db as never, [dir])
    db.prepare('UPDATE tracks SET rating = 60').run()

    await rm(join(dir, 'gone.flac'))
    const report = await scanRoots(db as never, [dir])

    expect(report.markedMissing).toBe(1)
    expect(tracks()).toBe(1)
    expect((db.prepare('SELECT present FROM media').get() as { present: number }).present).toBe(0)
    expect((db.prepare('SELECT rating FROM tracks').get() as { rating: number }).rating).toBe(60)
  })

  it('re-reads a file whose contents changed', async () => {
    const p = join(dir, 'edited.flac')
    await writeFile(p, flac('c'.repeat(32), Buffer.alloc(512, 6)))
    await scanRoots(db as never, [dir])

    await writeFile(p, flac('d'.repeat(32), Buffer.alloc(1024, 7)))
    await utimes(p, new Date(), new Date(Date.now() + 5000))

    const report = await scanRoots(db as never, [dir])
    expect(report.filesRead).toBe(1)
    expect(media()).toBe(1)
  })

  it('never overwrites X-Music statistics from a tag', async () => {
    await writeFile(join(dir, 'x.flac'), flac('e'.repeat(32), Buffer.alloc(512, 8)))
    await scanRoots(db as never, [dir])
    db.prepare('UPDATE tracks SET rating = 80, play_count = 42').run()

    await utimes(join(dir, 'x.flac'), new Date(), new Date(Date.now() + 9000))
    await scanRoots(db as never, [dir])

    const t = db.prepare('SELECT rating, play_count FROM tracks').get() as
      { rating: number; play_count: number }
    expect(t).toEqual({ rating: 80, play_count: 42 })
  })

  it('records unreadable files as errors instead of aborting the scan', async () => {
    await writeFile(join(dir, 'broken.flac'), Buffer.from('this is definitely not audio at all'))
    await writeFile(join(dir, 'fine.flac'), flac('f'.repeat(32), Buffer.alloc(512, 9)))

    const report = await scanRoots(db as never, [dir])
    expect(report.filesFound).toBe(2)
    expect(report.errors.length + report.filesRead).toBe(2)
  })

  it('reports an outcome for every file it touches', async () => {
    await writeFile(join(dir, 'a.flac'), flac('3'.repeat(32), Buffer.alloc(512, 20)))
    // A file with no valid preamble is what actually fails to parse; a truncated-but-signed file
    // is tolerated by music-metadata and indexed with empty tags.
    await writeFile(join(dir, 'bad.flac'), Buffer.from('this is definitely not audio at all'))

    const seen: { path: string; outcome: string }[] = []
    const first = await scanRoots(db as never, [dir], { onFile: (r) => seen.push(r) })

    expect(seen).toHaveLength(first.filesFound)
    expect(seen.map((s) => s.outcome).sort()).toEqual(['error', 'new'])
  })

  it('labels a rescan unchanged, a move moved, and a deletion missing', async () => {
    const md5 = '4'.repeat(32)
    await writeFile(join(dir, 'one.flac'), flac(md5, Buffer.alloc(512, 21)))
    await scanRoots(db as never, [dir])

    let seen: { path: string; outcome: string }[] = []
    await scanRoots(db as never, [dir], { onFile: (r) => seen.push(r) })
    expect(seen.map((s) => s.outcome)).toEqual(['unchanged'])

    await rename(join(dir, 'one.flac'), join(dir, 'two.flac'))
    seen = []
    await scanRoots(db as never, [dir], { onFile: (r) => seen.push(r) })
    expect(seen.find((s) => s.outcome === 'moved')).toBeDefined()

    await rm(join(dir, 'two.flac'))
    seen = []
    await scanRoots(db as never, [dir], { onFile: (r) => seen.push(r) })
    expect(seen.map((s) => s.outcome)).toContain('missing')
  })

  it('reports progress as it goes', async () => {
    await writeFile(join(dir, 'p.flac'), flac('1'.repeat(32), Buffer.alloc(512, 10)))
    const phases: string[] = []
    await scanRoots(db as never, [dir], { onProgress: (p) => phases.push(p.phase) })
    expect(phases).toContain('reading')
    expect(phases).toContain('finishing')
  })

  it('leaves media outside the scanned roots alone', async () => {
    db.prepare("INSERT INTO tracks (title, added, modified) VALUES ('elsewhere', 0, 0)").run()
    const id = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id
    db.prepare(
      `INSERT INTO media (track_id, kind, uri, present, added) VALUES (?, 'file', '/other/x.flac', 1, 0)`
    ).run(id)

    await writeFile(join(dir, 'here.flac'), flac('2'.repeat(32), Buffer.alloc(512, 11)))
    const report = await scanRoots(db as never, [dir])

    expect(report.markedMissing).toBe(0)
    expect((db.prepare("SELECT present FROM media WHERE uri = '/other/x.flac'")
      .get() as { present: number }).present).toBe(1)
  })
})
