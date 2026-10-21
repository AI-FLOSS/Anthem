// Album identity (DESIGN-SPEC §17.1).
//
// An album row's id is what persists; its match_key is derived here from tags and may be
// recomputed. The importer and the scanner both key albums through this file, so the same file
// read by either lands on the same album.

import { dirname } from 'node:path'

import { field } from '@shared/fields'
import type { Db } from './identity'

const KEY_SEP = '\x1f'

/** How many different artists an album without an album artist needs before it counts as a compilation. */
export const COMPILATION_ARTISTS = 3

/** Splits a tag that holds several values, which containers do inconsistently. */
export function splitValues(value: string | string[] | null | undefined): string[] {
  if (value === undefined || value === null) return []
  const raw = Array.isArray(value) ? value : [value]
  return raw
    .flatMap((v) => String(v).split(/\s*[;/\0]\s*/))
    .map((v) => v.trim())
    .filter((v) => v !== '')
}

/** Casefolds, strips diacritics and collapses whitespace. */
export function normalize(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** A trailing bracketed edition note such as "(Remastered)" or "[2011 Deluxe Edition]". */
const EDITION_SUFFIX =
  /\s*[([][^)\]]*\b(?:remaster(?:ed)?|deluxe|expanded|anniversary|edition|bonus tracks?|special|collector'?s)\b[^)\]]*[)\]]\s*$/i

/** Names that say nothing about which album a file belongs to. */
const GENERIC_ALBUM = /^(?:unknown(?: album)?|untitled|various(?: artists)?|(?:cd|disc|disk)\s*\d+)$/

/** The album name as keyed: normalized, with edition notes removed so editions share an album. */
export function albumKeyName(album: string): string {
  let name = album
  for (let prev = ''; prev !== name;) {
    prev = name
    name = name.replace(EDITION_SUFFIX, '')
  }
  return normalize(name) || normalize(album)
}

/**
 * The first artist in a tag, normalized and without featured guests, so "A; B" from one reader and
 * "A feat. C" from another both count as A.
 */
const primaryArtist = (raw: string | null | undefined): string =>
  normalize((splitValues(raw)[0] ?? '').split(/\s+(?:feat\.?|ft\.|featuring)\s+/i)[0])

export interface AlbumInput {
  album?: string | null
  artist?: string | null
  albumArtist?: string | null
  year?: number | null
  compilation?: boolean
  mbReleaseId?: string | null
}

/** The folder, only when the album name is too generic to tell albums apart on its own. */
function folderTieBreak(album: string, uri: string | null | undefined): string {
  return uri && GENERIC_ALBUM.test(normalize(album)) ? dirname(uri) : ''
}

/** The key an album of many artists is filed under: no artist component. */
export function compilationKey(t: AlbumInput, uri?: string | null): string | null {
  if (!t.album?.trim()) return null
  return ['c', albumKeyName(t.album), t.year ?? '', folderTieBreak(t.album, uri)].join(KEY_SEP)
}

/**
 * The album a track belongs to: its MusicBrainz release when tagged, otherwise album artist (or
 * track artist), name and year, with tagged compilations dropping the artist.
 */
export function albumMatchKey(t: AlbumInput, uri?: string | null): string | null {
  if (!t.album?.trim()) return null
  if (t.mbReleaseId) return ['mb', t.mbReleaseId].join(KEY_SEP)

  const albumArtist = primaryArtist(t.albumArtist)
  if (!albumArtist && t.compilation) return compilationKey(t, uri)

  return ['a', albumArtist || primaryArtist(t.artist), albumKeyName(t.album), t.year ?? '',
    folderTieBreak(t.album, uri)].join(KEY_SEP)
}

export interface RegroupReport {
  compilationsFound: number
  tracksMoved: number
  albumsRemoved: number
}

/**
 * Moves albums with no album artist and at least three track artists onto one compilation album,
 * then deletes album rows nothing points at. Pinned albums and pinned tracks are left alone.
 */
export function regroupAlbums(db: Db): RegroupReport {
  const report: RegroupReport = { compilationsFound: 0, tracksMoved: 0, albumsRemoved: 0 }
  const artistField = field('artist').fieldId
  const albumArtistField = field('album_artist').fieldId

  // Tracks filed under a per-artist key, i.e. every candidate for being part of a compilation.
  const rows = db.prepare(`
    SELECT t.id, t.album_id AS albumId, t.year, a.name,
           (SELECT v.value FROM track_values tv JOIN values_ v ON v.id = tv.value_id
             WHERE tv.track_id = t.id AND tv.field_id = ? ORDER BY tv.ordinal LIMIT 1) AS artist,
           (SELECT m.uri FROM media m WHERE m.track_id = t.id ORDER BY m.id LIMIT 1) AS uri
      FROM tracks t JOIN albums a ON a.id = t.album_id
     WHERE t.pinned = 0 AND a.pinned = 0 AND a.match_key LIKE 'a' || char(31) || '%'
       AND NOT EXISTS (SELECT 1 FROM track_values tv
                        WHERE tv.track_id = t.id AND tv.field_id = ?)
  `).all(artistField as never, albumArtistField as never) as {
    id: number; albumId: number; year: number | null; name: string | null
    artist: string | null; uri: string | null
  }[]

  const groups = new Map<string, { input: AlbumInput; uri: string | null; artists: Set<string>; tracks: number[] }>()
  for (const r of rows) {
    const input = { album: r.name, year: r.year }
    const key = compilationKey(input, r.uri)
    if (key === null) continue
    let g = groups.get(key)
    if (!g) groups.set(key, g = { input, uri: r.uri, artists: new Set(), tracks: [] })
    g.artists.add(primaryArtist(r.artist))
    g.tracks.push(r.id)
  }

  const insertAlbum = db.prepare(`
    INSERT INTO albums (match_key, name, year, is_compilation, added) VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(match_key) DO UPDATE SET is_compilation = 1`)
  const selectAlbum = db.prepare('SELECT id FROM albums WHERE match_key = ?')
  const moveTrack = db.prepare('UPDATE tracks SET album_id = ? WHERE id = ?')
  const now = Date.now()

  for (const [key, g] of groups) {
    if (g.artists.size < COMPILATION_ARTISTS) continue
    insertAlbum.run(key as never, g.input.album as never, (g.input.year ?? null) as never, now as never)
    const albumId = (selectAlbum.get(key as never) as { id: number }).id
    for (const trackId of g.tracks) moveTrack.run(albumId as never, trackId as never)
    report.compilationsFound++
    report.tracksMoved += g.tracks.length
  }

  // An album a merge could still be undone onto has to survive, or the undo has nothing to restore.
  const removed = db.prepare(`
    DELETE FROM albums
     WHERE pinned = 0
       AND id NOT IN (SELECT album_id FROM tracks WHERE album_id IS NOT NULL)
       AND id NOT IN (SELECT json_extract(j.value, '$.album_id')
                        FROM merge_journal m, json_each(m.snapshot, '$.tracks') j
                       WHERE m.undone = 0 AND json_extract(j.value, '$.album_id') IS NOT NULL)
  `).run() as { changes: number }
  report.albumsRemoved = removed.changes

  return report
}
