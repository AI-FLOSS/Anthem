// Imports a parsed gmbrc into Anthem's entity model.
//
// gmusicbrowser has one row per file; Anthem has a track plus its media. The import creates one
// track and one file-media per gmusicbrowser song, which is correct but conservative: it does not
// try to merge two files that are the same recording. Deduplication is a separate, reviewable
// operation, and silently merging someone's library on import would be the wrong default.

import { join } from 'node:path'
import { regroupAlbums } from '../library/albums'
import { createUpserter, type Db, type TrackCandidate } from '../library/identity'
import type { GmbrcData } from './gmbrc'

export interface ImportOptions {
  /** Import ratings, play counts and history. */
  statistics?: boolean
  /** Import genre, grouping and label as multi-value fields. */
  labels?: boolean
  /** Import SavedLists as static playlists. */
  playlists?: boolean
}

export interface ImportReport {
  songsRead: number
  tracksCreated: number
  tracksUpdated: number
  mediaMatched: number
  mediaCreated: number
  missingFlagged: number
  playHistoryRows: number
  playlistsCreated: number
  savedFiltersFound: number
  unmappedColumns: string[]
  notes: string[]
}

/** gmusicbrowser timestamps are unix seconds; Anthem stores milliseconds. */
const toMs = (secs: number | undefined): number | null =>
  secs === undefined || secs <= 0 ? null : secs * 1000

export function importGmbrc(db: Db, data: GmbrcData, opts: ImportOptions = {}): ImportReport {
  const withStats = opts.statistics ?? true
  const withLabels = opts.labels ?? true
  const withPlaylists = opts.playlists ?? true

  const report: ImportReport = {
    songsRead: data.songs.length,
    tracksCreated: 0,
    tracksUpdated: 0,
    mediaMatched: 0,
    mediaCreated: 0,
    missingFlagged: 0,
    playHistoryRows: 0,
    playlistsCreated: 0,
    savedFiltersFound: data.savedFilters.length,
    unmappedColumns: data.unmappedColumns,
    notes: []
  }

  const now = Date.now()
  const upsert = createUpserter(db)

  const insertHistory = db.prepare(
    'INSERT OR IGNORE INTO play_history (track_id, at, kind) VALUES (?, ?, ?)')
  const insertPlaylist = db.prepare(
    "INSERT INTO playlists (name, kind, created, modified) VALUES (?, 'static', ?, ?)")
  const selectPlaylist = db.prepare("SELECT id FROM playlists WHERE name = ? AND kind = 'static'")
  const clearPlaylist = db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?')
  const insertPlaylistTrack = db.prepare(
    'INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)')
  const lastId = db.prepare('SELECT last_insert_rowid() AS id')

  /** gmusicbrowser song id to Anthem track id, so SavedLists can be resolved afterwards. */
  const trackByGmbId = new Map<number, number>()

  db.exec('BEGIN')
  try {
    for (const song of data.songs) {
      const candidate: TrackCandidate = {
        title: song.title ?? null,
        album: song.album ?? null,
        artist: song.artist ?? null,
        albumArtist: song.albumArtist ?? null,
        year: song.year ?? null,
        trackNumber: song.track ?? null,
        discNumber: song.disc ?? null,
        lengthMs: song.length !== undefined ? song.length * 1000 : null,
        compilation: song.compilation ?? false,
        bpm: null,
        rating: withStats ? song.rating ?? null : null,
        playCount: withStats ? song.playCount ?? 0 : 0,
        skipCount: withStats ? song.skipCount ?? 0 : 0,
        lastPlayed: withStats ? toMs(song.lastPlay) : null,
        lastSkipped: withStats ? toMs(song.lastSkip) : null,
        rgTrackGain: song.rgTrackGain ?? null,
        rgAlbumGain: song.rgAlbumGain ?? null,
        added: toMs(song.added) ?? now,
        comment: song.comment ?? null,
        sets: {
          artist: song.artist ? [song.artist] : [],
          album_artist: song.albumArtist ? [song.albumArtist] : [],
          ...(withLabels
            ? { genre: song.genre, grouping: song.grouping, tags: song.label }
            : {})
        }
      }

      // A gmusicbrowser entry always names a file; without one there is nothing to attach to.
      if (!song.path || !song.file) {
        report.notes.push(`Skipped song ${song.gmbId}: no file path recorded.`)
        continue
      }

      const result = upsert(candidate, {
        uri: join(song.path, song.file),
        codec: song.filetype?.split(/\s+/)[0] ?? null,
        bitrate: song.bitrate ?? null,
        samplerate: song.sampleRate ?? null,
        channels: song.channels ?? null,
        filesize: song.size ?? null,
        mtime: toMs(song.modif),
        present: !song.missing
      }, { statistics: withStats, metadata: true })

      if (result.created) report.tracksCreated++
      else report.tracksUpdated++
      if (result.matchedBy === 'uri' || result.matchedBy === 'audio_hash') report.mediaMatched++
      else report.mediaCreated++
      if (song.missing) report.missingFlagged++

      trackByGmbId.set(song.gmbId, result.trackId)

      if (withStats) {
        for (const at of song.playHistory) {
          insertHistory.run(result.trackId as never, (at * 1000) as never, 0 as never)
          report.playHistoryRows++
        }
      }
    }

    if (withPlaylists) {
      for (const list of data.savedLists) {
        const existing = selectPlaylist.get(list.name as never) as { id: number } | undefined
        let playlistId: number
        if (existing) {
          playlistId = existing.id
          clearPlaylist.run(playlistId as never)
        } else {
          insertPlaylist.run(list.name as never, now as never, now as never)
          playlistId = (lastId.get() as { id: number }).id
        }
        let position = 0
        for (const gmbId of list.gmbIds) {
          const trackId = trackByGmbId.get(gmbId)
          if (trackId !== undefined) {
            insertPlaylistTrack.run(playlistId as never, trackId as never, position++ as never)
          }
        }
        report.playlistsCreated++
      }
    }

    regroupAlbums(db)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  if (data.savedFilters.length > 0) {
    report.notes.push(
      `${data.savedFilters.length} saved filters found but not translated. gmusicbrowser filter ` +
      'strings map onto the Anthem filter AST, which is a separate import step (DESIGN-SPEC 9.3).'
    )
  }
  if (report.missingFlagged > 0) {
    report.notes.push(
      `${report.missingFlagged} files were flagged missing by gmusicbrowser. Their tracks were ` +
      'imported with the media marked not present, so ratings and history are preserved.'
    )
  }
  if (data.unmappedColumns.length > 0) {
    report.notes.push(`Unmapped gmbrc columns ignored: ${data.unmappedColumns.join(', ')}`)
  }

  return report
}
