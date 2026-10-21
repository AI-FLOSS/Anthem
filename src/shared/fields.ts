// Field descriptors: the typed metadata that gives every field its storage, filtering, sorting,
// display and tag-mapping behaviour, per DESIGN-SPEC §3.1.

export type FieldType =
  | 'string' | 'text' | 'set' | 'artist' | 'integer' | 'float' | 'rating'
  | 'date' | 'datelist' | 'duration' | 'bool' | 'path' | 'enum'

// 'media' fields describe a physical source rather than the music; they match when ANY of a
// track's media satisfies the predicate.
export type FieldStorage = 'column' | 'multi' | 'extra' | 'media' | 'computed'

export type FieldFlag =
  | 'filterable' | 'groupable' | 'sortable' | 'editable' | 'columnar' | 'searchable' | 'writable'

/** Per-container tag mappings, keyed by tag format. */
export interface TagMapping {
  id3v2?: string
  vorbis?: string
  ilst?: string
  ape?: string
}

export interface FieldDescriptor {
  id: string
  name: string
  type: FieldType
  storage: FieldStorage
  flags: readonly FieldFlag[]
  /** Physical column name when storage is 'column'; defaults to id. */
  column?: string
  /** Stable numeric id for multi-value and extra storage; must never be reused. */
  fieldId?: number
  tags?: TagMapping
  range?: readonly [number, number]
  width?: number
  align?: 'left' | 'right'
  /** Populated for computed fields: a SQL expression over the tracks table. */
  expr?: string
}

const f = (d: FieldDescriptor): FieldDescriptor => d

/**
 * The v1 built-in catalogue. This is deliberately data, not code — user-defined fields are
 * appended to it at runtime and are indistinguishable from built-ins downstream.
 */
export const BUILTIN_FIELDS: readonly FieldDescriptor[] = [
  // ── file / physical ────────────────────────────────────────────────────────
  f({ id: 'path', name: 'Path', type: 'path', storage: 'media', column: 'uri', width: 400,
      flags: ['filterable', 'groupable', 'sortable', 'columnar', 'searchable'] }),
  f({ id: 'folder', name: 'Folder', type: 'path', storage: 'media', column: 'uri', width: 220,
      flags: ['filterable', 'groupable', 'sortable', 'columnar'] }),
  f({ id: 'filesize', name: 'Size', type: 'integer', storage: 'media', width: 80, align: 'right',
      flags: ['filterable', 'sortable', 'columnar'] }),
  f({ id: 'mtime', name: 'Modified', type: 'date', storage: 'media', width: 150,
      flags: ['filterable', 'sortable', 'columnar'] }),
  f({ id: 'added', name: 'Added', type: 'date', storage: 'column', width: 150,
      flags: ['filterable', 'groupable', 'sortable', 'columnar'] }),
  f({ id: 'codec', name: 'Codec', type: 'enum', storage: 'media', width: 70,
      flags: ['filterable', 'groupable', 'sortable', 'columnar'] }),
  f({ id: 'bitrate', name: 'Bitrate', type: 'integer', storage: 'media', width: 80, align: 'right',
      flags: ['filterable', 'groupable', 'sortable', 'columnar'] }),
  f({ id: 'samplerate', name: 'Sample rate', type: 'integer', storage: 'media', width: 90, align: 'right',
      flags: ['filterable', 'groupable', 'sortable', 'columnar'] }),
  f({ id: 'channels', name: 'Channels', type: 'integer', storage: 'media', width: 60, align: 'right',
      flags: ['filterable', 'groupable', 'sortable', 'columnar'] }),
  f({ id: 'length', name: 'Length', type: 'duration', storage: 'column', column: 'length_ms',
      width: 70, align: 'right',
      flags: ['filterable', 'sortable', 'columnar'] }),

  // ── core tags ──────────────────────────────────────────────────────────────
  f({ id: 'title', name: 'Title', type: 'string', storage: 'column', width: 260,
      tags: { id3v2: 'TIT2', vorbis: 'TITLE', ilst: '©nam', ape: 'Title' },
      flags: ['filterable', 'sortable', 'editable', 'columnar', 'searchable', 'writable'] }),
  f({ id: 'artist', name: 'Artist', type: 'artist', storage: 'multi', fieldId: 1, width: 200,
      tags: { id3v2: 'TPE1', vorbis: 'ARTIST', ilst: '©ART', ape: 'Artist' },
      flags: ['filterable', 'groupable', 'sortable', 'editable', 'columnar', 'searchable', 'writable'] }),
  f({ id: 'album_artist', name: 'Album artist', type: 'artist', storage: 'multi', fieldId: 2, width: 200,
      tags: { id3v2: 'TPE2', vorbis: 'ALBUMARTIST', ilst: 'aART', ape: 'Album Artist' },
      flags: ['filterable', 'groupable', 'sortable', 'editable', 'columnar', 'searchable', 'writable'] }),
  f({ id: 'album', name: 'Album', type: 'string', storage: 'computed', width: 200,
      expr: '(SELECT a.name FROM albums a WHERE a.id = t.album_id)',
      tags: { id3v2: 'TALB', vorbis: 'ALBUM', ilst: '©alb', ape: 'Album' },
      flags: ['filterable', 'groupable', 'sortable', 'editable', 'columnar', 'searchable', 'writable'] }),
  f({ id: 'composer', name: 'Composer', type: 'artist', storage: 'multi', fieldId: 3, width: 160,
      tags: { id3v2: 'TCOM', vorbis: 'COMPOSER', ilst: '©wrt', ape: 'Composer' },
      flags: ['filterable', 'groupable', 'sortable', 'editable', 'columnar', 'searchable', 'writable'] }),
  f({ id: 'year', name: 'Year', type: 'integer', storage: 'column', width: 55, align: 'right',
      tags: { id3v2: 'TDRC', vorbis: 'DATE', ilst: '©day', ape: 'Year' },
      flags: ['filterable', 'groupable', 'sortable', 'editable', 'columnar', 'writable'] }),
  f({ id: 'track_number', name: 'Track', type: 'integer', storage: 'column', width: 50, align: 'right',
      tags: { id3v2: 'TRCK', vorbis: 'TRACKNUMBER', ilst: 'trkn', ape: 'Track' },
      flags: ['filterable', 'sortable', 'editable', 'columnar', 'writable'] }),
  f({ id: 'disc_number', name: 'Disc', type: 'integer', storage: 'column', width: 45, align: 'right',
      tags: { id3v2: 'TPOS', vorbis: 'DISCNUMBER', ilst: 'disk', ape: 'Disc' },
      flags: ['filterable', 'sortable', 'editable', 'columnar', 'writable'] }),
  f({ id: 'compilation', name: 'Compilation', type: 'bool', storage: 'column', width: 40,
      tags: { id3v2: 'TCMP', vorbis: 'COMPILATION', ilst: 'cpil', ape: 'Compilation' },
      flags: ['filterable', 'groupable', 'sortable', 'editable', 'columnar', 'writable'] }),
  f({ id: 'bpm', name: 'BPM', type: 'integer', storage: 'column', width: 55, align: 'right',
      tags: { id3v2: 'TBPM', vorbis: 'BPM', ilst: 'tmpo', ape: 'BPM' },
      flags: ['filterable', 'groupable', 'sortable', 'editable', 'columnar', 'writable'] }),
  f({ id: 'comment', name: 'Comment', type: 'text', storage: 'extra', fieldId: 20, width: 200,
      tags: { id3v2: 'COMM', vorbis: 'COMMENT', ilst: '©cmt', ape: 'Comment' },
      flags: ['filterable', 'editable', 'columnar', 'searchable', 'writable'] }),
  f({ id: 'lyrics', name: 'Lyrics', type: 'text', storage: 'extra', fieldId: 21,
      tags: { id3v2: 'USLT', vorbis: 'LYRICS', ilst: '©lyr', ape: 'Lyrics' },
      flags: ['filterable', 'editable', 'searchable', 'writable'] }),

  // ── set-typed (multi-value) ────────────────────────────────────────────────
  f({ id: 'genre', name: 'Genre', type: 'set', storage: 'multi', fieldId: 4, width: 120,
      tags: { id3v2: 'TCON', vorbis: 'GENRE', ilst: '©gen', ape: 'Genre' },
      flags: ['filterable', 'groupable', 'sortable', 'editable', 'columnar', 'searchable', 'writable'] }),
  f({ id: 'grouping', name: 'Grouping', type: 'set', storage: 'multi', fieldId: 5, width: 120,
      tags: { id3v2: 'TIT1', vorbis: 'GROUPING', ilst: '©grp', ape: 'Grouping' },
      flags: ['filterable', 'groupable', 'sortable', 'editable', 'columnar', 'searchable', 'writable'] }),
  f({ id: 'mood', name: 'Mood', type: 'set', storage: 'multi', fieldId: 6, width: 120,
      tags: { id3v2: 'TMOO', vorbis: 'MOOD', ape: 'Mood' },
      flags: ['filterable', 'groupable', 'sortable', 'editable', 'columnar', 'writable'] }),
  f({ id: 'tags', name: 'Labels', type: 'set', storage: 'multi', fieldId: 7, width: 140,
      flags: ['filterable', 'groupable', 'sortable', 'editable', 'columnar', 'searchable'] }),

  // ── statistics (X-Music-owned) ──────────────────────────────────────────────
  f({ id: 'rating', name: 'Rating', type: 'rating', storage: 'column', width: 90, range: [0, 100],
      tags: { id3v2: 'POPM', vorbis: 'FMPS_RATING', ape: 'FMPS_RATING' },
      flags: ['filterable', 'groupable', 'sortable', 'editable', 'columnar'] }),
  f({ id: 'play_count', name: 'Plays', type: 'integer', storage: 'column', width: 55, align: 'right',
      flags: ['filterable', 'groupable', 'sortable', 'columnar'] }),
  f({ id: 'skip_count', name: 'Skips', type: 'integer', storage: 'column', width: 55, align: 'right',
      flags: ['filterable', 'groupable', 'sortable', 'columnar'] }),
  f({ id: 'last_played', name: 'Last played', type: 'date', storage: 'column', width: 150,
      flags: ['filterable', 'groupable', 'sortable', 'columnar'] }),
  f({ id: 'last_skipped', name: 'Last skipped', type: 'date', storage: 'column', width: 150,
      flags: ['filterable', 'sortable', 'columnar'] }),

  // ── loudness ───────────────────────────────────────────────────────────────
  f({ id: 'rg_track_gain', name: 'RG track gain', type: 'float', storage: 'column', width: 90, align: 'right',
      tags: { id3v2: 'TXXX:REPLAYGAIN_TRACK_GAIN', vorbis: 'REPLAYGAIN_TRACK_GAIN' },
      flags: ['filterable', 'sortable', 'columnar'] }),
  f({ id: 'rg_album_gain', name: 'RG album gain', type: 'float', storage: 'column', width: 90, align: 'right',
      tags: { id3v2: 'TXXX:REPLAYGAIN_ALBUM_GAIN', vorbis: 'REPLAYGAIN_ALBUM_GAIN' },
      flags: ['filterable', 'sortable', 'columnar'] })
]

export const FIELDS_BY_ID: ReadonlyMap<string, FieldDescriptor> =
  new Map(BUILTIN_FIELDS.map((d) => [d.id, d]))

export function field(id: string): FieldDescriptor {
  const d = FIELDS_BY_ID.get(id)
  if (!d) throw new Error(`unknown field: ${id}`)
  return d
}

export function fieldsWith(flag: FieldFlag): FieldDescriptor[] {
  return BUILTIN_FIELDS.filter((d) => d.flags.includes(flag))
}

/** Stars are the display unit; 0-100 is the storage unit. See DESIGN-SPEC §3.6. */
export const starsToRating = (stars: number): number => Math.round(stars * 20)
export const ratingToStars = (rating: number | null): number | null =>
  rating === null ? null : rating / 20
