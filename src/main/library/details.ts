// Everything X-Music knows about one track.
//
// This is where the entity model becomes visible to the user: not just tags, but how many sources
// back the track, where each one is, which will actually play, and how the track came to be
// identified the way it is (DESIGN-SPEC §6.5). Read-only.

import { BUILTIN_FIELDS } from '@shared/fields'
import type { Db } from './identity'

export interface DetailMedia {
  id: number
  kind: string
  uri: string
  provider: string | null
  present: boolean
  preferred: boolean
  codec: string | null
  container: string | null
  bitrate: number | null
  bitrateMode: string | null
  samplerate: number | null
  channels: number | null
  bitsPerSample: number | null
  filesize: number | null
  mtime: number | null
  lastSeen: number | null
  qualityRank: number
  audioHashHex: string | null
  audioHashAlgo: string | null
  subtrackIndex: number
  startMs: number | null
  endMs: number | null
  /** Raw tags read from this source, so disagreements between sources stay visible. */
  tags: { field: string; value: string }[]
}

export interface DetailField {
  field: string
  name: string
  value: string | null
  multi: boolean
}

export interface HistoryEntry {
  at: number
  kind: 'play' | 'skip'
}

export interface TrackDetails {
  id: number
  title: string | null
  album: string | null
  albumId: number | null

  identity: {
    source: string
    key: string | null
    pinned: boolean
    mbRecordingId: string | null
    acoustid: string | null
  }

  fields: DetailField[]
  media: DetailMedia[]

  statistics: {
    rating: number | null
    playCount: number
    skipCount: number
    firstPlayed: number | null
    lastPlayed: number | null
    lastSkipped: number | null
    added: number
    modified: number
    bookmarkMs: number | null
  }

  loudness: {
    rgTrackGain: number | null
    rgAlbumGain: number | null
  }

  /** Most recent first, capped: the full list can run to hundreds of entries. */
  history: HistoryEntry[]
  historyTotal: number

  /** Present when this track absorbed others, so the merge can be found and undone. */
  merges: { batchId: string; at: number; absorbed: number }[]
}

const HISTORY_LIMIT = 200

const fieldNameById = (): Map<number, { id: string; name: string }> => {
  const map = new Map<number, { id: string; name: string }>()
  for (const d of BUILTIN_FIELDS) {
    if (d.fieldId !== undefined) map.set(d.fieldId, { id: d.id, name: d.name })
  }
  return map
}

export function trackDetails(db: Db, trackId: number): TrackDetails | null {
  const t = db.prepare(`
    SELECT t.id, t.title, t.album_id AS albumId, t.year, t.track_number AS trackNumber,
           t.disc_number AS discNumber, t.length_ms AS lengthMs, t.compilation, t.bpm,
           t.identity_source AS identitySource, t.identity_key AS identityKey, t.pinned,
           t.mb_recording_id AS mbRecordingId, t.acoustid,
           t.rating, t.play_count AS playCount, t.skip_count AS skipCount,
           t.first_played AS firstPlayed, t.last_played AS lastPlayed,
           t.last_skipped AS lastSkipped, t.added, t.modified, t.bookmark_ms AS bookmarkMs,
           t.rg_track_gain AS rgTrackGain, t.rg_album_gain AS rgAlbumGain,
           (SELECT a.name FROM albums a WHERE a.id = t.album_id) AS album
    FROM tracks t WHERE t.id = ?`).get(trackId as never) as Record<string, unknown> | undefined

  if (!t) return null

  const names = fieldNameById()

  // Multi-value fields, collapsed for display but marked so the UI can say they are sets.
  const setRows = db.prepare(`
    SELECT tv.field_id AS fieldId, vv.value FROM track_values tv
    JOIN values_ vv ON vv.id = tv.value_id
    WHERE tv.track_id = ? ORDER BY tv.field_id, tv.ordinal`).all(trackId as never) as
    { fieldId: number; value: string }[]

  const sets = new Map<number, string[]>()
  for (const r of setRows) sets.set(r.fieldId, [...(sets.get(r.fieldId) ?? []), r.value])

  const extraRows = db.prepare(
    'SELECT field_id AS fieldId, value FROM track_extras WHERE track_id = ?')
    .all(trackId as never) as { fieldId: number; value: string }[]

  const fields: DetailField[] = []

  const scalar = (id: string, name: string, value: unknown): void => {
    fields.push({
      field: id, name, multi: false,
      value: value === null || value === undefined || value === '' ? null : String(value)
    })
  }

  scalar('title', 'Title', t.title)
  scalar('album', 'Album', t.album)
  scalar('year', 'Year', t.year)
  scalar('track_number', 'Track', t.trackNumber)
  scalar('disc_number', 'Disc', t.discNumber)
  scalar('length', 'Length', t.lengthMs)
  scalar('bpm', 'BPM', t.bpm)
  scalar('compilation', 'Compilation', t.compilation ? 'Yes' : null)

  for (const [fieldId, values] of sets) {
    const meta = names.get(fieldId)
    if (!meta) continue
    fields.push({ field: meta.id, name: meta.name, value: values.join(', '), multi: true })
  }

  for (const r of extraRows) {
    const meta = names.get(r.fieldId)
    if (!meta) continue
    fields.push({ field: meta.id, name: meta.name, value: r.value, multi: false })
  }

  // ── sources ──────────────────────────────────────────────────────────────
  const mediaRows = db.prepare(`
    SELECT id, kind, uri, provider, present, codec, container, bitrate,
           bitrate_mode AS bitrateMode, samplerate, channels, bits_per_sample AS bitsPerSample,
           filesize, mtime, last_seen AS lastSeen, quality_rank AS qualityRank,
           audio_hash AS audioHash, audio_hash_algo AS audioHashAlgo,
           subtrack_index AS subtrackIndex, start_ms AS startMs, end_ms AS endMs
    FROM media WHERE track_id = ?
    ORDER BY present DESC, quality_rank DESC, id`).all(trackId as never) as Record<string, unknown>[]

  const tagRows = db.prepare(`
    SELECT media_id AS mediaId, field_id AS fieldId, value FROM media_tags
    WHERE media_id IN (SELECT id FROM media WHERE track_id = ?)
    ORDER BY media_id, field_id, ordinal`).all(trackId as never) as
    { mediaId: number; fieldId: number; value: string | null }[]

  const media: DetailMedia[] = mediaRows.map((m, index) => {
    const hash = m.audioHash as Uint8Array | null
    return {
      id: m.id as number,
      kind: m.kind as string,
      uri: m.uri as string,
      provider: (m.provider ?? null) as string | null,
      present: !!m.present,
      // The first row is what the player would choose, by the same ordering it uses.
      preferred: index === 0,
      codec: (m.codec ?? null) as string | null,
      container: (m.container ?? null) as string | null,
      bitrate: (m.bitrate ?? null) as number | null,
      bitrateMode: (m.bitrateMode ?? null) as string | null,
      samplerate: (m.samplerate ?? null) as number | null,
      channels: (m.channels ?? null) as number | null,
      bitsPerSample: (m.bitsPerSample ?? null) as number | null,
      filesize: (m.filesize ?? null) as number | null,
      mtime: (m.mtime ?? null) as number | null,
      lastSeen: (m.lastSeen ?? null) as number | null,
      qualityRank: (m.qualityRank ?? 0) as number,
      audioHashHex: hash ? Buffer.from(hash).toString('hex') : null,
      audioHashAlgo: (m.audioHashAlgo ?? null) as string | null,
      subtrackIndex: (m.subtrackIndex ?? 0) as number,
      startMs: (m.startMs ?? null) as number | null,
      endMs: (m.endMs ?? null) as number | null,
      tags: tagRows
        .filter((r) => r.mediaId === m.id && r.value !== null)
        .map((r) => ({ field: names.get(r.fieldId)?.name ?? `field ${r.fieldId}`, value: r.value! }))
    }
  })

  // ── history ──────────────────────────────────────────────────────────────
  const historyTotal = (db.prepare('SELECT COUNT(*) AS n FROM play_history WHERE track_id = ?')
    .get(trackId as never) as { n: number }).n

  const history = (db.prepare(
    'SELECT at, kind FROM play_history WHERE track_id = ? ORDER BY at DESC LIMIT ?')
    .all(trackId as never, HISTORY_LIMIT as never) as { at: number; kind: number }[])
    .map((r) => ({ at: r.at, kind: r.kind === 1 ? 'skip' as const : 'play' as const }))

  const merges = (db.prepare(`
    SELECT batch_id AS batchId, at, snapshot FROM merge_journal
    WHERE survivor_id = ? AND undone = 0 ORDER BY at DESC`).all(trackId as never) as
    { batchId: string; at: number; snapshot: string }[])
    .map((m) => {
      let absorbed = 0
      try {
        absorbed = Math.max(0, (JSON.parse(m.snapshot) as { tracks: unknown[] }).tracks.length - 1)
      } catch {
        absorbed = 0
      }
      return { batchId: m.batchId, at: m.at, absorbed }
    })

  return {
    id: t.id as number,
    title: (t.title ?? null) as string | null,
    album: (t.album ?? null) as string | null,
    albumId: (t.albumId ?? null) as number | null,
    identity: {
      source: (t.identitySource ?? 'heuristic') as string,
      key: (t.identityKey ?? null) as string | null,
      pinned: !!t.pinned,
      mbRecordingId: (t.mbRecordingId ?? null) as string | null,
      acoustid: (t.acoustid ?? null) as string | null
    },
    fields,
    media,
    statistics: {
      rating: (t.rating ?? null) as number | null,
      playCount: (t.playCount ?? 0) as number,
      skipCount: (t.skipCount ?? 0) as number,
      firstPlayed: (t.firstPlayed ?? null) as number | null,
      lastPlayed: (t.lastPlayed ?? null) as number | null,
      lastSkipped: (t.lastSkipped ?? null) as number | null,
      added: (t.added ?? 0) as number,
      modified: (t.modified ?? 0) as number,
      bookmarkMs: (t.bookmarkMs ?? null) as number | null
    },
    loudness: {
      rgTrackGain: (t.rgTrackGain ?? null) as number | null,
      rgAlbumGain: (t.rgAlbumGain ?? null) as number | null
    },
    history,
    historyTotal,
    merges
  }
}
