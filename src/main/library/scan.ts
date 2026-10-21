// Filesystem scanner.
//
// Reads only: files are opened 'r' for tag parsing and hashing, and nothing here ever writes to the
// music tree. Identity resolution is delegated to identity.ts, so scanning a library that was
// already imported from gmusicbrowser attaches to the existing tracks instead of duplicating them.

import { readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { parseFile } from 'music-metadata'

import { regroupAlbums, splitValues } from './albums'
import { hashAudio, needsRehash } from './audio-hash'
import { createUpserter, type Db, type MediaCandidate, type TrackCandidate } from './identity'

export const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.m4b', '.mp4', '.aac', '.wav', '.aiff',
  '.aif', '.wv', '.ape', '.mpc', '.wma', '.dsf', '.tta', '.spx'
])

/** What happened to one file, reported as the scan goes rather than only in the summary. */
export type FileOutcome = 'new' | 'matched' | 'moved' | 'unchanged' | 'error' | 'missing'

export interface FileResult {
  path: string
  outcome: FileOutcome
  /** Why, for errors; the previous path, for moves. */
  detail?: string
  trackId?: number
}

export interface ScanOptions {
  /** Directory names skipped wholesale. */
  excludeDirs?: readonly string[]
  /** Skip hashing; much faster, but move detection stops working. For slow network mounts. */
  slow?: boolean
  onProgress?: (p: ScanProgress) => void
  onFile?: (r: FileResult) => void
  signal?: { aborted: boolean }
}

export interface ScanProgress {
  phase: 'walking' | 'reading' | 'finishing'
  found: number
  processed: number
  currentPath?: string
}

export interface ScanReport {
  filesFound: number
  filesRead: number
  filesSkipped: number
  tracksCreated: number
  tracksMatched: number
  movesDetected: number
  markedMissing: number
  errors: { path: string; message: string }[]
  durationMs: number
}

const DEFAULT_EXCLUDES = ['.git', 'node_modules', '@eaDir', '.Trash-1000', 'lost+found']

/** Yields every audio file beneath `root`, depth first, skipping excluded directories. */
async function* walk(
  root: string,
  excludes: ReadonlySet<string>,
  onDir?: (path: string) => void
): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return // An unreadable directory is skipped, not fatal.
  }

  onDir?.(root)

  for (const entry of entries) {
    const full = join(root, entry.name)

    if (entry.isDirectory()) {
      if (excludes.has(entry.name)) continue
      yield* walk(full, excludes, onDir)
    } else if (entry.isFile()) {
      if (AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) yield full
    }
  }
}

const first = (v: readonly string[] | undefined): string | null => v?.[0] ?? null

export async function scanRoots(
  db: Db,
  roots: readonly string[],
  opts: ScanOptions = {}
): Promise<ScanReport> {
  const started = Date.now()
  const excludes = new Set([...DEFAULT_EXCLUDES, ...(opts.excludeDirs ?? [])])

  const report: ScanReport = {
    filesFound: 0, filesRead: 0, filesSkipped: 0, tracksCreated: 0, tracksMatched: 0,
    movesDetected: 0, markedMissing: 0, errors: [], durationMs: 0
  }

  // Collect first so the total is known and progress can be honest about how far along it is.
  const files: string[] = []
  for (const root of roots) {
    for await (const file of walk(root, excludes)) {
      files.push(file)
      if (files.length % 500 === 0) {
        opts.onProgress?.({ phase: 'walking', found: files.length, processed: 0 })
      }
      if (opts.signal?.aborted) break
    }
  }
  report.filesFound = files.length

  const upsert = createUpserter(db)
  const unchanged = db.prepare(
    'SELECT id, audio_hash_algo AS algo FROM media ' +
    'WHERE uri = ? AND subtrack_index = 0 AND mtime = ? AND filesize = ?')
  const touch = db.prepare('UPDATE media SET present = 1, last_seen = ? WHERE id = ?')

  const seen = new Set<number>()
  const BATCH = 200
  let batchOpen = false

  const openBatch = (): void => {
    if (!batchOpen) { db.exec('BEGIN'); batchOpen = true }
  }
  const closeBatch = (): void => {
    if (batchOpen) { db.exec('COMMIT'); batchOpen = false }
  }

  for (let i = 0; i < files.length; i++) {
    if (opts.signal?.aborted) break
    const path = files[i]!

    if (i % 25 === 0) {
      opts.onProgress?.({
        phase: 'reading', found: files.length, processed: i, currentPath: path
      })
    }

    openBatch()
    try {
      const info = await stat(path)
      const mtime = Math.floor(info.mtimeMs)

      // Unchanged files are the common case on a rescan; skip the expensive part entirely, unless the
      // stored hash is missing or weaker than what hashing now produces.
      const hit = unchanged.get(path as never, mtime as never, info.size as never) as
        { id: number; algo: string | null } | undefined
      if (hit && (opts.slow || !needsRehash(path, hit.algo))) {
        touch.run(Date.now() as never, hit.id as never)
        seen.add(hit.id)
        report.filesSkipped++
        opts.onFile?.({ path, outcome: 'unchanged' })
        continue
      }

      const meta = await parseFile(path, { duration: true, skipCovers: true })
      const c = meta.common
      const f = meta.format

      const track: TrackCandidate = {
        title: c.title ?? null,
        album: c.album ?? null,
        artist: first(splitValues(c.artists ?? c.artist)) ?? c.artist ?? null,
        albumArtist: c.albumartist ?? null,
        year: c.year ?? null,
        trackNumber: c.track?.no ?? null,
        discNumber: c.disk?.no ?? null,
        lengthMs: f.duration !== undefined ? Math.round(f.duration * 1000) : null,
        compilation: c.compilation ?? false,
        bpm: typeof c.bpm === 'number' ? Math.round(c.bpm) : null,
        mbRecordingId: c.musicbrainz_recordingid ?? null,
        mbReleaseId: c.musicbrainz_albumid ?? null,
        acoustid: c.acoustid_id ?? null,
        comment: c.comment?.map((x) => (typeof x === 'string' ? x : x.text)).join(' ') || null,
        sets: {
          artist: splitValues(c.artists ?? c.artist),
          album_artist: c.albumartist ? [c.albumartist] : [],
          genre: splitValues(c.genre),
          grouping: splitValues(c.grouping)
        }
      }

      const media: MediaCandidate = {
        uri: path,
        codec: (f.codec ?? extname(path).slice(1)).toLowerCase(),
        bitrate: f.bitrate !== undefined ? Math.round(f.bitrate / 1000) : null,
        samplerate: f.sampleRate ?? null,
        channels: f.numberOfChannels ?? null,
        bitsPerSample: f.bitsPerSample ?? null,
        filesize: info.size,
        mtime,
        present: true
      }

      if (!opts.slow) {
        try {
          const h = await hashAudio(path)
          media.audioHash = h.hash
          media.audioHashAlgo = h.algo
        } catch {
          // A file that cannot be hashed still gets indexed; it just loses move detection.
        }
      }

      // Tags are not authoritative for X-Music's own statistics.
      const result = upsert(track, media, { statistics: false, metadata: true })
      seen.add(result.mediaId)
      report.filesRead++

      if (result.created) {
        report.tracksCreated++
        opts.onFile?.({ path, outcome: 'new', trackId: result.trackId })
      } else if (result.moved) {
        report.movesDetected++
        report.tracksMatched++
        opts.onFile?.({
          path, outcome: 'moved', trackId: result.trackId,
          detail: `matched by ${result.matchedBy === 'audio_hash' ? 'audio content' : result.matchedBy}`
        })
      } else {
        report.tracksMatched++
        opts.onFile?.({
          path, outcome: 'matched', trackId: result.trackId,
          detail: `matched by ${result.matchedBy === 'audio_hash' ? 'audio content' : result.matchedBy}`
        })
      }
    } catch (err) {
      const message = (err as Error).message
      report.errors.push({ path, message })
      opts.onFile?.({ path, outcome: 'error', detail: message })
    } finally {
      if ((i + 1) % BATCH === 0) closeBatch()
    }
  }

  closeBatch()

  // Anything under a scanned root that was not seen is gone from disk. The media is flagged, never
  // deleted, so its track keeps its rating and history (DESIGN-SPEC §3.4).
  opts.onProgress?.({ phase: 'finishing', found: files.length, processed: files.length })

  if (!opts.signal?.aborted && roots.length > 0) {
    db.exec('BEGIN')
    try {
      const candidates = db.prepare(
        `SELECT id, uri FROM media WHERE kind = 'file' AND present = 1`
      ).all() as { id: number; uri: string }[]

      const markMissing = db.prepare('UPDATE media SET present = 0 WHERE id = ?')
      for (const m of candidates) {
        const underRoot = roots.some((r) => m.uri.startsWith(r.endsWith('/') ? r : `${r}/`))
        if (underRoot && !seen.has(m.id)) {
          markMissing.run(m.id as never)
          report.markedMissing++
          opts.onFile?.({ path: m.uri, outcome: 'missing', detail: 'no longer on disk' })
        }
      }
      db.exec('COMMIT')
    } catch {
      db.exec('ROLLBACK')
    }
  }

  db.exec('BEGIN')
  try {
    regroupAlbums(db)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  report.durationMs = Date.now() - started
  return report
}
