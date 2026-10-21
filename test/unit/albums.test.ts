// Album identity (DESIGN-SPEC §17.1): which tracks share an album row, and that the rows stay put
// across rescans instead of multiplying.

import { describe, expect, it, beforeEach, afterEach } from 'vitest'

import { albumMatchKey, regroupAlbums } from '@main/library/albums'
import { createUpserter, type TrackCandidate } from '@main/library/identity'
import { freshDb, type TestDb } from '../helpers/sqlite'

let db: TestDb
let upsert: ReturnType<typeof createUpserter>

const albums = (): number => (db.prepare('SELECT COUNT(*) AS n FROM albums').get() as { n: number }).n
const albumOf = (trackId: number): number =>
  (db.prepare('SELECT album_id AS a FROM tracks WHERE id = ?').get(trackId) as { a: number }).a

/** Imports one track at `uri`, returning its track id. */
function add(t: TrackCandidate, uri: string): number {
  const sets = { artist: t.artist ? [t.artist] : [], album_artist: t.albumArtist ? [t.albumArtist] : [] }
  return upsert({ sets, ...t }, { uri }, { metadata: true }).trackId
}

beforeEach(() => {
  db = freshDb()
  upsert = createUpserter(db as never)
})

afterEach(() => db.close())

describe('album match key', () => {
  it('ignores case, diacritics, spacing and edition notes', () => {
    const a = albumMatchKey({ album: 'Café  Tacvba', artist: 'X', year: 1994 })
    const b = albumMatchKey({ album: 'cafe tacvba (Remastered)', artist: 'x', year: 1994 })
    const c = albumMatchKey({ album: 'Cafe Tacvba [Deluxe Edition]', artist: 'X', year: 1994 })
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it('keeps different years apart, so a remaster is its own album', () => {
    expect(albumMatchKey({ album: 'A', artist: 'X', year: 1973 }))
      .not.toBe(albumMatchKey({ album: 'A', artist: 'X', year: 2011 }))
  })

  it('agrees whether the artist tag was split or not, as the importer and scanner differ', () => {
    expect(albumMatchKey({ album: 'A', artist: 'X; Y' })).toBe(albumMatchKey({ album: 'A', artist: 'X' }))
    expect(albumMatchKey({ album: 'A', artist: 'X feat. Z' })).toBe(albumMatchKey({ album: 'A', artist: 'X' }))
  })

  it('prefers the album artist over the track artist', () => {
    expect(albumMatchKey({ album: 'A', artist: 'Guest', albumArtist: 'Band' }))
      .toBe(albumMatchKey({ album: 'A', artist: 'Band' }))
  })

  it('uses the MusicBrainz release id when there is one', () => {
    expect(albumMatchKey({ album: 'A', artist: 'X', mbReleaseId: 'r1' }))
      .toBe(albumMatchKey({ album: 'Other', artist: 'Y', mbReleaseId: 'r1' }))
  })

  it('separates generic album names by folder', () => {
    expect(albumMatchKey({ album: 'CD1', artist: 'X' }, '/m/one/a.mp3'))
      .not.toBe(albumMatchKey({ album: 'CD1', artist: 'X' }, '/m/two/a.mp3'))
    expect(albumMatchKey({ album: 'Real Name', artist: 'X' }, '/m/one/a.mp3'))
      .toBe(albumMatchKey({ album: 'Real Name', artist: 'X' }, '/m/two/a.mp3'))
  })

  it('has no album for a track with no album name', () => {
    expect(albumMatchKey({ album: '  ', artist: 'X' })).toBeNull()
  })
})

describe('regrouping', () => {
  it('files three artists with no album artist under one compilation', () => {
    const ids = ['P', 'Q', 'R'].map((artist, i) => add({ album: 'Soundtrack', artist, year: 2000 }, `/m/${i}.mp3`))
    expect(new Set(ids.map(albumOf)).size).toBe(3)

    const r = regroupAlbums(db as never)
    expect(r.compilationsFound).toBe(1)
    expect(new Set(ids.map(albumOf)).size).toBe(1)
    expect(albums()).toBe(1)
    expect((db.prepare('SELECT is_compilation AS c FROM albums').get() as { c: number }).c).toBe(1)
  })

  it('leaves two artists on separate albums', () => {
    add({ album: 'Split', artist: 'P', year: 2000 }, '/m/1.mp3')
    add({ album: 'Split', artist: 'Q', year: 2000 }, '/m/2.mp3')
    expect(regroupAlbums(db as never).compilationsFound).toBe(0)
    expect(albums()).toBe(2)
  })

  it('does not treat tracks with an album artist as a compilation', () => {
    for (const [i, artist] of ['P', 'Q', 'R'].entries()) {
      add({ album: 'Hits', artist, albumArtist: 'Band', year: 2000 }, `/m/${i}.mp3`)
    }
    expect(regroupAlbums(db as never).compilationsFound).toBe(0)
    expect(albums()).toBe(1)
  })

  it('files a tagged compilation together without waiting for a regroup', () => {
    const a = add({ album: 'Mix', artist: 'P', compilation: true }, '/m/1.mp3')
    const b = add({ album: 'Mix', artist: 'Q', compilation: true }, '/m/2.mp3')
    expect(albumOf(a)).toBe(albumOf(b))
  })

  it('keeps album ids stable when the same files are read again', () => {
    const tracks = [
      { album: 'Soundtrack', artist: 'P', year: 2000 },
      { album: 'Soundtrack', artist: 'Q', year: 2000 },
      { album: 'Soundtrack', artist: 'R', year: 2000 },
      { album: 'Solo', artist: 'S; T', year: 1990 }
    ]
    const ids = tracks.map((t, i) => add(t, `/m/${i}.mp3`))
    regroupAlbums(db as never)
    const before = ids.map(albumOf)
    const count = albums()

    // A rescan reads the split artist tag differently from the importer.
    tracks.forEach((t, i) => add({ ...t, artist: t.artist.split(';')[0]! }, `/m/${i}.mp3`))
    regroupAlbums(db as never)

    expect(ids.map(albumOf)).toEqual(before)
    expect(albums()).toBe(count)
  })

  it('deletes albums no track points at', () => {
    const id = add({ album: 'Old Name', artist: 'P' }, '/m/1.mp3')
    add({ album: 'New Name', artist: 'P' }, '/m/1.mp3')
    expect(albums()).toBe(2)

    expect(regroupAlbums(db as never).albumsRemoved).toBe(1)
    expect(albums()).toBe(1)
    expect(albumOf(id)).not.toBeNull()
  })

  it('keeps an empty album that is pinned or that an undoable merge refers to', () => {
    db.prepare("INSERT INTO albums (match_key, name, pinned, added) VALUES ('pinned', 'P', 1, 0)").run()
    db.prepare("INSERT INTO albums (match_key, name, added) VALUES ('journaled', 'J', 0)").run()
    const journaled = (db.prepare("SELECT id FROM albums WHERE match_key = 'journaled'").get() as { id: number }).id
    db.prepare("INSERT INTO albums (match_key, name, added) VALUES ('orphan', 'O', 0)").run()
    db.prepare('INSERT INTO merge_journal (batch_id, at, survivor_id, snapshot) VALUES (?, 0, 1, ?)')
      .run('b1', JSON.stringify({ tracks: [{ id: 9, album_id: journaled }] }))

    regroupAlbums(db as never)
    const keys = (db.prepare('SELECT match_key AS k FROM albums ORDER BY k').all() as { k: string }[]).map((r) => r.k)
    expect(keys).toEqual(['journaled', 'pinned'])
  })

  it('never moves a track off a pinned album', () => {
    const id = add({ album: 'Arranged', artist: 'P' }, '/m/1.mp3')
    const album = albumOf(id)
    db.prepare('UPDATE albums SET pinned = 1 WHERE id = ?').run(album)

    add({ album: 'Retagged', artist: 'P' }, '/m/1.mp3')
    expect(albumOf(id)).toBe(album)
  })
})
