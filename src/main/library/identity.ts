// Resolving what a file is, and which track it belongs to.
//
// Both the gmbrc importer and the filesystem scanner funnel through here, so that running either
// one twice is idempotent and running both does not produce two tracks for one song. The rule is
// deliberately narrow: a file is matched to an existing track only when we can prove it is the same
// file (same path, or same audio content). Guessing that two *different* files are the same
// recording is a separate, reviewable operation — see DESIGN-SPEC §9.2.

import { field } from '@shared/fields'
import { albumMatchKey, compilationKey } from './albums'

type Statement = {
  run: (...args: never[]) => unknown
  get: (...args: never[]) => unknown
  all: (...args: never[]) => unknown[]
}

export type Db = {
  prepare: (sql: string) => Statement
  exec: (sql: string) => unknown
}

export interface MediaCandidate {
  uri: string
  subtrackIndex?: number
  audioHash?: Uint8Array | null
  audioHashAlgo?: string | null
  codec?: string | null
  bitrate?: number | null
  samplerate?: number | null
  channels?: number | null
  bitsPerSample?: number | null
  filesize?: number | null
  mtime?: number | null
  present?: boolean
}

export interface TrackCandidate {
  title?: string | null
  album?: string | null
  artist?: string | null
  albumArtist?: string | null
  year?: number | null
  trackNumber?: number | null
  discNumber?: number | null
  lengthMs?: number | null
  compilation?: boolean
  bpm?: number | null
  mbRecordingId?: string | null
  mbReleaseId?: string | null
  acoustid?: string | null

  rating?: number | null
  playCount?: number | null
  skipCount?: number | null
  lastPlayed?: number | null
  lastSkipped?: number | null
  rgTrackGain?: number | null
  rgAlbumGain?: number | null
  added?: number | null

  /** Multi-value fields, keyed by field id. Replaces what is stored, rather than appending. */
  sets?: Record<string, readonly string[]>
  comment?: string | null
}

export interface UpsertOptions {
  /**
   * Whether the source is authoritative for ratings, play counts and history. True for the
   * gmusicbrowser import; false for a filesystem scan, which must never clobber Anthem's own
   * statistics with whatever happens to be in a tag.
   */
  statistics?: boolean
  /** Whether to replace multi-value fields and the comment. */
  metadata?: boolean
}

export type MatchSource = 'uri' | 'audio_hash' | 'mbid' | 'new'

export interface UpsertResult {
  trackId: number
  mediaId: number
  matchedBy: MatchSource
  created: boolean
  moved: boolean
}

const KEY_SEP = ''

const norm = (s: string | null | undefined): string =>
  (s ?? '').trim().toLocaleLowerCase().replace(/\s+/g, ' ')

/**
 * A stable descriptor of what this track *is*, stored for a later deduplication pass. It is not
 * used to merge automatically — two files that agree on artist, title and album are usually the
 * same recording, but "usually" is not good enough to silently collapse someone's library.
 */
export function identityKey(t: TrackCandidate): string {
  if (t.mbRecordingId) return `mbid${KEY_SEP}${t.mbRecordingId}`

  const artist = norm(t.albumArtist ?? t.artist)
  const title = norm(t.title)
  if (title === '') return ''

  return ['t', artist, title, norm(t.album)].join(KEY_SEP)
}

/** Higher is preferred when several sources back one track. */
export function qualityRank(m: MediaCandidate): number {
  const lossless = new Set(['flac', 'alac', 'wav', 'aiff', 'wavpack', 'ape'])
  const codec = (m.codec ?? '').toLocaleLowerCase()
  const base = lossless.has(codec) ? 10_000 : 0
  return base + Math.min(m.bitrate ?? 0, 9_999)
}

class Upserter {
  private readonly s: Record<string, Statement>
  private readonly valueCache = new Map<string, number>()

  constructor(private readonly db: Db) {
    this.s = {
      mediaByUri: db.prepare(
        'SELECT id, track_id FROM media WHERE uri = ? AND subtrack_index = ?'),
      mediaByHash: db.prepare(
        'SELECT id, track_id, uri FROM media WHERE audio_hash = ? LIMIT 1'),
      trackByMbid: db.prepare(
        'SELECT id FROM tracks WHERE mb_recording_id = ? LIMIT 1'),

      insertAlbum: db.prepare(
        'INSERT OR IGNORE INTO albums (match_key, name, year, mb_release_id, is_compilation, added) ' +
        'VALUES (?, ?, ?, ?, ?, ?)'),
      selectAlbum: db.prepare('SELECT id FROM albums WHERE match_key = ?'),
      pinnedAlbumOf: db.prepare(
        'SELECT a.id FROM tracks t JOIN albums a ON a.id = t.album_id WHERE t.id = ? AND a.pinned = 1'),

      insertTrack: db.prepare(`
        INSERT INTO tracks (title, album_id, year, track_number, disc_number, length_ms,
                            compilation, bpm, mb_recording_id, acoustid, identity_source,
                            identity_key, rating, play_count, skip_count, last_played,
                            last_skipped, rg_track_gain, rg_album_gain, added, modified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),

      updateTrackMeta: db.prepare(`
        UPDATE tracks SET title = ?, album_id = ?, year = ?, track_number = ?, disc_number = ?,
                          length_ms = ?, compilation = ?, bpm = ?, identity_key = ?, modified = ?
        WHERE id = ? AND pinned = 0`),

      updateTrackStats: db.prepare(`
        UPDATE tracks SET rating = ?, play_count = ?, skip_count = ?, last_played = ?,
                          last_skipped = ?, rg_track_gain = ?, rg_album_gain = ?, modified = ?
        WHERE id = ?`),

      insertMedia: db.prepare(`
        INSERT INTO media (track_id, kind, uri, subtrack_index, audio_hash, audio_hash_algo,
                           codec, bitrate, samplerate, channels, bits_per_sample, filesize,
                           mtime, present, quality_rank, last_seen, added)
        VALUES (?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),

      updateMedia: db.prepare(`
        UPDATE media SET uri = ?, audio_hash = ?, audio_hash_algo = ?, codec = ?, bitrate = ?,
                         samplerate = ?, channels = ?, bits_per_sample = ?, filesize = ?,
                         mtime = ?, present = ?, quality_rank = ?, last_seen = ?
        WHERE id = ?`),

      insertValue: db.prepare('INSERT OR IGNORE INTO values_ (field_id, value) VALUES (?, ?)'),
      selectValue: db.prepare('SELECT id FROM values_ WHERE field_id = ? AND value = ?'),
      clearSet: db.prepare('DELETE FROM track_values WHERE track_id = ? AND field_id = ?'),
      insertTv: db.prepare(
        'INSERT OR IGNORE INTO track_values (track_id, field_id, value_id, ordinal) VALUES (?, ?, ?, ?)'),
      upsertExtra: db.prepare(
        'INSERT INTO track_extras (track_id, field_id, value) VALUES (?, ?, ?) ' +
        'ON CONFLICT(track_id, field_id) DO UPDATE SET value = excluded.value'),

      lastId: db.prepare('SELECT last_insert_rowid() AS id')
    }
  }

  private rowId(): number {
    return (this.s.lastId!.get() as { id: number }).id
  }

  private intern(fieldId: number, value: string): number {
    const key = `${fieldId}${KEY_SEP}${value}`
    const hit = this.valueCache.get(key)
    if (hit !== undefined) return hit

    this.s.insertValue!.run(fieldId as never, value as never)
    const id = (this.s.selectValue!.get(fieldId as never, value as never) as { id: number }).id
    this.valueCache.set(key, id)
    return id
  }

  private albumId(t: TrackCandidate, uri: string, trackId: number | null, now: number): number | null {
    // An album arranged by hand keeps its tracks whatever their tags now say.
    if (trackId !== null) {
      const current = this.s.pinnedAlbumOf!.get(trackId as never) as { id: number } | undefined
      if (current) return current.id
    }

    const key = albumMatchKey(t, uri)
    if (key === null) return null

    // Once a regroup has filed this album as a compilation, later tracks without an album artist join it.
    if (!t.albumArtist && !t.mbReleaseId) {
      const comp = this.s.selectAlbum!.get(compilationKey(t, uri) as never) as { id: number } | undefined
      if (comp) return comp.id
    }

    this.s.insertAlbum!.run(
      key as never, t.album as never, (t.year ?? null) as never, (t.mbReleaseId ?? null) as never,
      (key.startsWith('c') ? 1 : 0) as never, now as never)
    return (this.s.selectAlbum!.get(key as never) as { id: number }).id
  }

  private writeSets(trackId: number, sets: Record<string, readonly string[]>): void {
    for (const [fieldId, values] of Object.entries(sets)) {
      const fid = field(fieldId).fieldId
      if (fid === undefined) continue

      // Replace rather than append, or a second import doubles every genre.
      this.s.clearSet!.run(trackId as never, fid as never)
      values.forEach((v, ordinal) => {
        if (v.trim() === '') return
        this.s.insertTv!.run(trackId as never, fid as never, this.intern(fid, v) as never, ordinal as never)
      })
    }
  }

  upsert(track: TrackCandidate, media: MediaCandidate, opts: UpsertOptions): UpsertResult {
    const now = Date.now()
    const subtrack = media.subtrackIndex ?? 0
    const hash = media.audioHash ?? null

    let trackId: number | null = null
    let mediaId: number | null = null
    let matchedBy: MatchSource = 'new'
    let moved = false

    // 1. The same path is the same media, full stop.
    const byUri = this.s.mediaByUri!.get(media.uri as never, subtrack as never) as
      { id: number; track_id: number } | undefined
    if (byUri) {
      mediaId = byUri.id
      trackId = byUri.track_id
      matchedBy = 'uri'
    }

    // 2. Same audio content at a different path means the file moved or was renamed.
    if (trackId === null && hash) {
      const byHash = this.s.mediaByHash!.get(hash as never) as
        { id: number; track_id: number; uri: string } | undefined
      if (byHash) {
        mediaId = byHash.id
        trackId = byHash.track_id
        matchedBy = 'audio_hash'
        moved = byHash.uri !== media.uri
      }
    }

    // 3. A MusicBrainz recording id is an explicit statement of identity.
    if (trackId === null && track.mbRecordingId) {
      const byMbid = this.s.trackByMbid!.get(track.mbRecordingId as never) as
        { id: number } | undefined
      if (byMbid) {
        trackId = byMbid.id
        matchedBy = 'mbid'
      }
    }

    const key = identityKey(track)
    const album = this.albumId(track, media.uri, trackId, now)
    const created = trackId === null

    if (created) {
      this.s.insertTrack!.run(
        (track.title ?? null) as never, album as never, (track.year ?? null) as never,
        (track.trackNumber ?? null) as never, (track.discNumber ?? null) as never,
        (track.lengthMs ?? null) as never, (track.compilation ? 1 : 0) as never,
        (track.bpm ?? null) as never, (track.mbRecordingId ?? null) as never,
        (track.acoustid ?? null) as never,
        (track.mbRecordingId ? 'mbid' : 'heuristic') as never,
        (key || null) as never,
        (opts.statistics ? track.rating ?? null : null) as never,
        (opts.statistics ? track.playCount ?? 0 : 0) as never,
        (opts.statistics ? track.skipCount ?? 0 : 0) as never,
        (opts.statistics ? track.lastPlayed ?? null : null) as never,
        (opts.statistics ? track.lastSkipped ?? null : null) as never,
        (track.rgTrackGain ?? null) as never, (track.rgAlbumGain ?? null) as never,
        (track.added ?? now) as never, now as never
      )
      trackId = this.rowId()
    } else {
      if (opts.metadata !== false) {
        // A pinned track was arranged by hand; the UPDATE's WHERE clause leaves it alone.
        this.s.updateTrackMeta!.run(
          (track.title ?? null) as never, album as never, (track.year ?? null) as never,
          (track.trackNumber ?? null) as never, (track.discNumber ?? null) as never,
          (track.lengthMs ?? null) as never, (track.compilation ? 1 : 0) as never,
          (track.bpm ?? null) as never, (key || null) as never, now as never, trackId as never
        )
      }
      if (opts.statistics) {
        this.s.updateTrackStats!.run(
          (track.rating ?? null) as never, (track.playCount ?? 0) as never,
          (track.skipCount ?? 0) as never, (track.lastPlayed ?? null) as never,
          (track.lastSkipped ?? null) as never, (track.rgTrackGain ?? null) as never,
          (track.rgAlbumGain ?? null) as never, now as never, trackId as never
        )
      }
    }

    const rank = qualityRank(media)
    const present = (media.present ?? true) ? 1 : 0

    if (mediaId === null) {
      this.s.insertMedia!.run(
        trackId as never, media.uri as never, subtrack as never,
        hash as never, (media.audioHashAlgo ?? null) as never,
        (media.codec ?? null) as never, (media.bitrate ?? null) as never,
        (media.samplerate ?? null) as never, (media.channels ?? null) as never,
        (media.bitsPerSample ?? null) as never, (media.filesize ?? null) as never,
        (media.mtime ?? null) as never, present as never, rank as never, now as never, now as never
      )
      mediaId = this.rowId()
    } else {
      this.s.updateMedia!.run(
        media.uri as never, hash as never, (media.audioHashAlgo ?? null) as never,
        (media.codec ?? null) as never, (media.bitrate ?? null) as never,
        (media.samplerate ?? null) as never, (media.channels ?? null) as never,
        (media.bitsPerSample ?? null) as never, (media.filesize ?? null) as never,
        (media.mtime ?? null) as never, present as never, rank as never, now as never,
        mediaId as never
      )
    }

    if (opts.metadata !== false) {
      if (track.sets) this.writeSets(trackId!, track.sets)
      if (track.comment) {
        this.s.upsertExtra!.run(
          trackId as never, field('comment').fieldId as never, track.comment as never)
      }
    }

    return { trackId: trackId!, mediaId: mediaId!, matchedBy, created, moved }
  }
}

export function createUpserter(db: Db): (t: TrackCandidate, m: MediaCandidate, o: UpsertOptions) => UpsertResult {
  const u = new Upserter(db)
  return (t, m, o) => u.upsert(t, m, o)
}
