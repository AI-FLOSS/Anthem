# Anthem — Design Specification

**Status:** v0.3 · skeleton implemented · see README.md for what runs today
**One line:** a desktop music player with gmusicbrowser's data model and power, a web-technology UI
that users can re-layout and re-skin, and Halon as its reference theme.

---

## 1. What Anthem is

gmusicbrowser is the most capable Linux music library manager ever written — arbitrary user-defined
fields, a real filter algebra, smart playlists, mass tagging, and a layout system where the entire
window is user-assembled from widgets. It is also Perl/GTK2, effectively unmaintained, and its
customization story ends at a bespoke `.layout` file format that almost nobody learns.

Anthem keeps the model and replaces the substrate:

| gmusicbrowser | Anthem |
|---|---|
| Perl + GTK2 | Rust core + web UI in a native shell |
| In-memory Perl column store | SQLite (source of truth) + in-memory columnar index |
| `.layout` DSL, GTK widgets | JSON layout documents, web component registry |
| GTK theme + per-widget hacks | CSS custom properties from a design-token file |
| Field defs hardcoded in `gmusicbrowser_songs.pm` | Field defs as data, user fields first-class |
| Filter strings (`rating:>:60`) | Filter AST (JSON), compiles to SQL *and* to a native predicate |

### 1.1 Non-goals for v1

- Not a streaming client. Local files (and network mounts) only. Streaming is a plugin surface later.
- Not a mobile app. Desktop first; the UI being web tech makes a remote-control web view cheap later,
  but it is not v1 scope.
- Not a DJ tool, not a tag *database* (MusicBrainz Picard's job) — Anthem writes tags well but does
  not try to out-Picard Picard on acoustic fingerprinting.

### 1.2 Success criteria

1. 50,000-track library: cold start to interactive under 3 seconds; any filter, sort or group under
   100 ms. Larger libraries must degrade gracefully, not fall over (§12.1).
2. Every gmusicbrowser filter operator has an Anthem equivalent, and an importer converts existing
   gmusicbrowser filters and layouts.
3. A user can move a panel, add a column, and restyle the whole app without recompiling anything.
4. Tag edits round-trip losslessly across MP3/FLAC/Ogg/Opus/M4A/WavPack/APE.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Renderer (Chromium)  —  TypeScript · Preact + signals · Vite       │
│  Deliberately thin: it maps state to pixels and nothing else.       │
│                                                                     │
│  ┌───────────────┐  ┌──────────────┐  ┌────────────────────────┐    │
│  │ Layout engine │  │ Widget       │  │ Theme runtime          │    │
│  │ (JSON → tree) │  │ registry     │  │ (tokens → CSS vars)    │    │
│  └───────────────┘  └──────────────┘  └────────────────────────┘    │
└──────────────────────────────┬──────────────────────────────────────┘
              contextBridge IPC, typed by src/shared/ipc.ts
┌──────────────────────────────┴──────────────────────────────────────┐
│  src/shared/  —  imported by BOTH sides, framework-free, no DOM     │
│                                                                     │
│  field descriptors · filter AST · format strings · view state       │
│  (selection, sort, filter stack, virtualization maths) · IPC types   │
└──────────────────────────────┬──────────────────────────────────────┘
┌──────────────────────────────┴──────────────────────────────────────┐
│  Main process (Node)                                                │
│                                                                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │ Library  │ │ Query    │ │ Tag I/O  │ │ Playback │ │ Services │   │
│  │ index    │ │ AST→SQL  │ │ TagIO    │ │ Engine   │ │ MPRIS,   │   │
│  │ scanner  │ │ AST→pred │ │ iface    │ │ iface    │ │ scrobble │   │
│  │ hashing  │ │          │ │ (taglib) │ │ (mpv)    │ │ hotkeys  │   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────────┘   │
│       └────────────┴────────────┴────────────┘                      │
│              SQLite (WAL, STRICT) + FTS5                            │
│                                                                     │
│  worker_threads: scan · hash · replaygain                           │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.1 Shell: Electron

Chosen over Tauri after the evaluation in Appendix A. The short version: mpv neutralizes the
playback argument, SQLite neutralizes most of the query argument, and scanning speed is background
work — which strips Rust's advantage down to memory footprint and headroom above ~250k tracks. That
is not worth a 2–3× slowdown in every UI iteration on a project whose two headline features (§5
layout, §5.4 theming) are both UI work.

One rendering engine instead of three is a real secondary win: `:has()`, container queries and
subgrid are all available, and the CSS baseline restrictions that a WebView-per-platform shell would
impose (§6.4) do not apply.

The honest cost: ~150 MB install and ~350–500 MB resident for an app people leave running for weeks.

**Rejected:** Tauri/Rust (see Appendix A.4 Stack A — reversal triggers are listed in §16), Python
core (worst packaging story, and the UI is TypeScript regardless, so it buys two languages for one
benefit), pure web/PWA (no tag writing, no gapless, no filesystem watch).

### 2.2 Renderer: TypeScript + Preact + signals + Vite

Preact because it is the React programming model — JSX, function components, hooks — which is the
most widely known way to write a web UI, in a 4 KB runtime. `@preact/signals` carries the view-model
stores: a component that reads a signal during render subscribes to it, and only that component
re-renders when it changes. That keeps the two hot paths — the song list and the playback position
tick — from re-rendering the tree above them. The song list's rows are memoized, so a selection
change re-renders the rows whose state changed rather than every row.

Styles are CSS Modules: each component has a `Foo.module.css` beside it, with class names scoped at
build time. Element selectors are not scoped by CSS Modules, so component stylesheets select on
classes only.

`preact/compat` makes most React libraries usable, including `dnd-kit` for the M7 layout editor.

**This choice is deliberately made cheap to reverse.** See §2.4: everything that is expensive to
rewrite lives outside the renderer.

### 2.3 Process model

Three execution contexts, and the split is not optional:

- **Main** — library, query engine, tag I/O, playback supervision, services. Owns the SQLite
  connection; nothing else may open the database.
- **`worker_threads` pool** — scanning, hashing, ReplayGain analysis. Mandatory,
  not an optimization: a blocked main thread stalls playback *control* and the UI simultaneously.
- **Renderer** — presentation. No Node integration, `contextIsolation` on, and a strict CSP.

IPC is `contextBridge` over the contract in `src/shared/ipc.ts`. Because both sides import the same
module, the boundary is typechecked end to end with no codegen step.

**One hazard is worth writing down, because it cost a wrong fix.** `contextBridge` clones
arguments as they cross from the page's world into the preload's isolated world — a clone that
happens *before* any preload code runs. So an argument that structured clone rejects, such as a
Proxy, fails with "An object could not be cloned" no matter what the preload does; the flattening
has to happen in the renderer. Every call therefore goes through `src/renderer/lib/ipc.ts`
rather than touching `window.anthem` directly.

The symptom is easy to misread: the handler never runs, so nothing appears in the main process log,
which looks like a return-value problem rather than an argument one.

### 2.3.1 Logging

Levels are `critical`, `error`, `warn`, `info` and `debug`, configured by `ANTHEM_LOG` — either a
bare level, or per-scope entries such as `warn,play:debug` so one area can be made noisy while the
rest stays quiet. `ANTHEM_LOG_FILE` additionally appends to a file.

Two decisions worth recording:

- **Renderer records travel to the main process** and join the same stream, in order, under one
  configuration. A renderer-only console is invisible from a terminal, and that is precisely what
  turned several UI bugs into guesswork; uncaught errors and unhandled rejections are forwarded
  automatically.
- **The level is read through a function, not captured.** The renderer learns its level from the
  main process *after* module load, so a logger created at import time would otherwise be stuck at
  the default forever — which is exactly the bug that made the first version silently drop every
  renderer debug line.

The parsing lives in `src/shared/log.ts`, apart from any transport, because the behaviour worth
testing is what a malformed specification does: it falls back rather than silencing logging, and one
bad entry does not discard the rest.

### 2.4 The UI-agnostic boundary

The single most valuable structural decision in the codebase: **anything expensive to rewrite lives
outside the renderer.**

`src/shared/` is plain TypeScript with no framework primitives, no reactivity library, and no DOM
access. It holds:

| Module | What it owns |
|---|---|
| `fields.ts` | Field descriptors: storage, filter operators, tag mappings, stable numeric ids |
| `filter.ts` | The filter AST, its operators, composition and cycle detection |
| `format.ts` | The format-string language (§5.5) — labels, tray text, the file renamer |
| `view.ts` | Selection model, sort state, filter stack, virtualization arithmetic |
| `ipc.ts` | The IPC contract |

`view.ts` deserves the emphasis. Anchored range selection, multi-key sort with shift-click
semantics, the filter stack that collapses to an AST, and the arithmetic deciding which rows a
viewport needs are all framework-neutral logic that every list widget shares. Implementing that
correctly is days of work; expressing it in a UI framework is hours. Keeping it in `shared/` means a
framework change — or a second front end, such as a remote web UI — re-does the hours, not the days.

The renderer is therefore expected to stay small: a widget registry, a layout tree renderer, thin
reactive wrappers over `shared/` classes, and CSS.

## 3. Data model

### 3.1 The core insight, borrowed from gmusicbrowser

In gmusicbrowser a *field* is not a column — it is a typed descriptor carrying its own storage
strategy, display format, filter operators, sort key, edit widget, and tag-format mappings. That's
why adding a user field there gives you filtering, sorting, grouping, column display, and tag
round-tripping for free. Anthem keeps this and makes it data instead of Perl.

```jsonc
// fields/rating.json — a built-in field descriptor
{
  "id": "rating",
  "name": "Rating",
  "type": "rating",            // resolves to a type descriptor (§3.3)
  "storage": "column",         // column | multi | virtual | computed
  "flags": ["filterable", "groupable", "sortable", "editable", "columnar", "searchable"],
  "tags": {
    "id3v2":  "POPM;;%r|TXXX;FMPS_Rating;%f",
    "vorbis": "FMPS_RATING|RATING",
    "ilst":   "----:com.apple.iTunes:FMPS_Rating",
    "ape":    "FMPS_RATING"
  },
  "default": null,             // null = unrated, distinct from 0
  "range": [0, 100]
}
```

### 3.2 Field catalogue (v1)

**File / physical**
`path`, `filename`, `folder`, `filesize`, `mtime`, `added`, `format`, `codec`, `bitrate`,
`bitrate_mode`, `samplerate`, `channels`, `bits_per_sample`, `length`, `hash_sha256` (dedup),
`missing` (bool).

**Core tags**
`title`, `artist` (multi), `album_artist` (multi), `album`, `album_artist_or_artist` (virtual),
`composer` (multi), `lyricist` (multi), `conductor` (multi), `remixer` (multi), `performer` (multi),
`year`, `original_year`, `date` (full ISO), `track_number`, `track_total`, `disc_number`,
`disc_total`, `disc_subtitle`, `version`, `compilation` (bool), `bpm`, `key`, `isrc`, `barcode`,
`catalog_number`, `label` (publisher), `media`, `language`, `comment`, `lyrics`.

**Set / multi-value ("flags" fields — gmusicbrowser's most underrated idea)**
`genre`, `grouping`, `mood`, `style`, `tags` (free-form user labels), `occasion`.
These are many-to-many, autocompleted, colour-assignable, and filterable with set semantics
(`has any`, `has all`, `has none`, `count`).

**MusicBrainz identity**
`mb_track_id`, `mb_recording_id`, `mb_release_id`, `mb_release_group_id`, `mb_artist_ids` (multi),
`mb_album_artist_ids` (multi), `acoustid`.

**Loudness**
`rg_track_gain`, `rg_track_peak`, `rg_album_gain`, `rg_album_peak`, `r128_track_gain`,
`r128_album_gain`, `loudness_lufs`, `dynamic_range`.

**Statistics (Anthem-owned, never guessed from tags)**
`rating` (0–100 stored, 5 stars displayed), `play_count`, `skip_count`, `last_played`, `last_skipped`,
`first_played`, `play_history` (timestamp list), `skip_history`, `bookmark_ms`, `love` (bool).

**Derived / computed**
`album_gid`, `artist_gid`, `has_cover`, `has_lyrics`, `is_duplicate`, `sort_title`, `sort_artist`,
`sort_album`, plus any user-defined expression field.

**User-defined fields**
Any number, of any type in §3.3, with an optional tag mapping. A user field with a tag mapping
round-trips to files; without one it lives only in Anthem's database.

### 3.2.1 Every field is a first-class field

**The rule, without exceptions:** any field — built in, derived from a tag, or defined by the user —
is filterable, sortable, groupable, and available as a song-list column. There is no second tier of
"extra" metadata that the UI can only display.

This is why §3.1 makes a field a *descriptor* rather than a column. A descriptor carries its storage
strategy, filter operators, sort key, group-by function and display format, so everything downstream
is generic over it:

| Consumer | How it stays generic |
|---|---|
| Filter compilers | Dispatch on `storage` (§3.5.2) and `type` (§3.3); no field is named in either compiler |
| Column picker | Lists `fieldsWith('columnar')`; a new field appears without touching the widget |
| Filter panes | Any `groupable` field is selectable in a pane — the dropdown is built from `fieldsWith('groupable')`, so a new field appears without touching the widget |
| Sort | Any `sortable` field is a sort key, in any position of a multi-key sort (§4.3.1) |
| Format strings | `{any_field}` resolves through the same descriptor lookup (§5.5) |
| Tag round-trip | A user field with a `tags` mapping writes to files; without one it lives only in the database |

`test/unit/fields.test.ts` already asserts the invariants this depends on — unique ids, a stable
numeric id for every multi-value and extra field, and an expression for every computed field.

**What is still missing to make the promise true end to end:**

1. **A field editor.** User-defined fields exist in the storage model (`track_extras`, and
   `field_id`-discriminated `track_values`) but there is no UI to define one. It needs: id, display
   name, type, single or multi-value, and an optional per-container tag mapping.
2. **Persisting user fields.** The catalogue is currently a TypeScript constant. User fields need a
   `fields` table, merged with the built-ins at startup, with numeric ids allocated from a range
   that can never collide with built-in ids.
3. **A column picker** in the song-list header context menu, driven by `fieldsWith('columnar')`.
4. **Derived-field expressions.** `storage: 'computed'` exists and is used for `album`, but the
   expression is authored in TypeScript. Letting a user write one means a small safe expression
   language over other fields — deliberately not raw SQL, which would be an injection surface.

### 3.3 Type descriptors

Each type supplies: storage encoding, display formatter, sort key, valid filter operators, group-by
function, edit widget, and tag serialization.

| type | notes | filter ops |
|---|---|---|
| `string` | case-preserving, case-insensitive compare | `is`, `contains`, `starts`, `ends`, `regex`, `empty` |
| `text` | long-form (lyrics, comment); FTS5-indexed | as `string` + `matches` (FTS) |
| `set` | multi-value, interned, colourable | `any`, `all`, `none`, `count`, `empty` |
| `artist` | `set` + sort-name + MBID identity + split rules | as `set` |
| `integer` | width-typed | `=`, `≠`, `>`, `<`, `≥`, `≤`, `between`, `top N`, `bottom N`, `empty` |
| `float` | NaN = "no value" (gmusicbrowser's trick, kept) | as `integer` + `defined` |
| `rating` | 0–100 · null ≠ 0 | as `integer` + `unrated` |
| `date` | ISO instant, UTC stored, local displayed | `before`, `after`, `between`, `in last N <unit>`, `empty` |
| `datelist` | play/skip history | `count in last N <unit>`, `ever`, `never` |
| `duration` | ms | as `integer`, formatted `m:ss` |
| `bool` | tri-state (true/false/unset) | `is` |
| `path` | prefix-tree grouped | `under`, `is`, `contains`, `regex` |
| `enum` | closed value set | `is`, `in`, `empty` |

### 3.4 The entity model: a track is not a file

**This is the load-bearing decision in Anthem, and it is what the database being the source of truth
actually means.**

A `track` is a logical piece of music. It survives renames, moves, format changes, retagging, and
having no file at all. Anything that can *render* it is a `media` row hanging off it:

| Case | Representation |
|---|---|
| An ordinary file | one `media` row, `kind='file'` |
| Same album in FLAC and MP3 | two `media` rows on one track |
| A CUE range inside a big rip | `media` rows sharing a `uri`, with `subtrack_index`, `start_ms`, `end_ms` |
| An audiobook chapter | identical shape to a CUE range |
| A streaming provider | `media` row with `kind='stream'` and a provider URI |
| A file on a disconnected drive | `media` row with `present = 0` — flagged, never deleted |
| A track you don't have yet | a track with **zero** media rows |

Consequences that fall out for free:

- **Statistics belong to the music, not the file.** Rating, play count and history live on `tracks`,
  so re-ripping an album in a better format loses nothing.
- **§17.2 is resolved.** CUE support is no longer a schema question; it is a parser plus a playback
  flag, because `media` already addresses ranges.
- **Streaming is not a special case.** A provider source is one more `media` kind, so smart
  playlists, ratings and filters work across local and remote without a second code path.
- **Missing files stop being destructive.** Losing a drive flags media, not tracks.

### 3.5 Two identities, deliberately separate

The most common modelling mistake here is to conflate two different questions. Anthem answers them
with different mechanisms:

| Question | Mechanism | Properties |
|---|---|---|
| *Did this file move or get renamed?* | **audio content hash** (`media.audio_hash`) | exact, offline, deterministic, no service |
| *Are these two files the same song?* | MBID → AcoustID → fuzzy, always confirmable | probabilistic, needs network, user-pinnable |

**The audio content hash** is computed over the audio stream with every metadata region excluded, so
retagging a file never changes its hash. FLAC gets this free — its STREAMINFO block already carries
an MD5 of the decoded audio. MP4 gets its `mdat` payloads hashed, since tags live in `moov`. Ogg
(Vorbis, Opus, Speex) gets its packets hashed with the comment packet left out — packets rather than
pages, because a retag repaginates the stream. ID3/APE-tagged formats get their frame region hashed
with the ID3v2 header, ID3v1 trailer and APE tag skipped. Anything else falls back to a whole-file hash, which is
still stable under moves but not under retagging; the algorithm used is recorded per media row in
`audio_hash_algo` so the weaker cases are visible rather than silently assumed.

**AcoustID is a hint, never a key.** It was evaluated as the primary identifier and rejected:

1. **It is not unique to a recording by design.** The AcoustID↔MusicBrainz-recording mapping is
   many-to-many. One AcoustID commonly points at several recordings and one recording has many
   AcoustIDs. This is why Picard does not blindly trust it. As a primary key it fails on its own
   terms before any collision argument.
2. **Matching is by similarity threshold, not equality** — that is how a 128 kbps MP3 matches a
   FLAC. So "collision probability" is not governed by the ID space, and birthday-paradox reasoning
   does not apply. False positives cluster in predictable categories: silence and near-silence,
   tracks under ~30 seconds, radio edits sharing a long intro with the album version, and remasters
   (inconsistently, in both directions).
3. **It requires the network.** Fingerprints can be computed offline, but the AcoustID itself is
   assigned by a web service. Keying the library on it makes the library unopenable offline.
4. **Fingerprinting means decoding ~120 s of every file** — a full read of the library and many
   hours of CPU at 250k tracks.
5. **Coverage is partial.** Own recordings, bootlegs, obscure releases and podcasts get nothing —
   exactly the files no external service can help with.

So `tracks.acoustid` exists as evidence, alongside `mb_recording_id`, and `identity_source` records
which one actually decided the grouping (`manual` | `mbid` | `acoustid` | `audio_hash` |
`heuristic`). `pinned = 1` marks a human decision that automated passes must never override — the
same reversibility trick used for album identity in §17.1.

### 3.5.0 Resolving a file to a track — implemented

Both the gmbrc importer and the filesystem scanner funnel through `src/main/library/identity.ts`, so
that running either twice is idempotent and running both does not produce two tracks for one song.

Resolution order, stopping at the first match:

| Order | Match | Meaning |
|---|---|---|
| 1 | `media.uri` + `subtrack_index` | The same path is the same media, full stop. |
| 2 | `media.audio_hash` | Same audio at a different path: the file moved or was renamed. |
| 3 | `tracks.mb_recording_id` | An explicit statement of identity. |
| 4 | — | Create a new track. |

**The rule is deliberately narrow.** A file attaches to an existing track only when we can *prove*
it is the same file. Concluding that two *different* files are the same recording is a separate,
reviewable operation (§9.2, §9.4) — silently collapsing someone's library on import would be the
wrong default, and unrecoverable without the undo journal.

`identity_key` is computed and stored anyway (`mbid:<id>`, or normalized artist + title + album) so
a later deduplication pass has something to group by without re-deriving it. `pinned = 1` marks a
human decision, and the metadata UPDATE carries `WHERE pinned = 0` so automated passes cannot
overwrite it.

Two policies fall out of the sources being different:

- **The importer is authoritative for statistics**; the scanner is not. A tag must never overwrite
  Anthem's own rating or play count, so `scanRoots` passes `statistics: false`.
- **Multi-value fields are replaced, not appended**, or a second import doubles every genre.

Play history needed a uniqueness constraint (migration 002: `UNIQUE(track_id, at, kind)`), without
which re-importing appended a second copy of every play event.

`test/unit/idempotency.test.ts` and `test/unit/scan.test.ts` pin all of this. The first version of
the importer failed these: it created 6 tracks from 3 on a second run, 3 of them orphans with no
media at all, because the track INSERT had no conflict clause while the media INSERT did.

### 3.5.1 Schema (abridged)

The authoritative version is `src/main/db/migrations/001-initial.sql`.

```sql
CREATE TABLE tracks (
  id              INTEGER PRIMARY KEY,
  title           TEXT,
  album_id        INTEGER REFERENCES albums(id) ON DELETE SET NULL,
  year            INTEGER, track_number INTEGER, disc_number INTEGER, length_ms INTEGER,

  mb_recording_id TEXT,
  acoustid        TEXT,                            -- a hint, never a key
  identity_source TEXT NOT NULL DEFAULT 'heuristic',
  identity_key    TEXT,
  pinned          INTEGER NOT NULL DEFAULT 0,      -- a human decided; do not re-derive

  rating          INTEGER,                         -- 0..100; NULL is unrated, which is not 0
  play_count      INTEGER NOT NULL DEFAULT 0,
  skip_count      INTEGER NOT NULL DEFAULT 0,
  last_played     INTEGER, last_skipped INTEGER, bookmark_ms INTEGER,

  added           INTEGER NOT NULL, modified INTEGER NOT NULL,
  primary_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL
) STRICT;

CREATE TABLE media (
  id              INTEGER PRIMARY KEY,
  track_id        INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,                   -- 'file' | 'stream'
  uri             TEXT NOT NULL,
  provider        TEXT,

  subtrack_index  INTEGER NOT NULL DEFAULT 0,      -- CUE ranges and chapters
  start_ms        INTEGER, end_ms INTEGER,

  audio_hash      BLOB,                            -- identity of the FILE (§3.5)
  audio_hash_algo TEXT,

  codec TEXT, bitrate INTEGER, samplerate INTEGER, channels INTEGER,
  filesize INTEGER, mtime INTEGER,

  present         INTEGER NOT NULL DEFAULT 1,      -- 0 = known but unreachable
  quality_rank    INTEGER NOT NULL DEFAULT 0,      -- which source to prefer
  added           INTEGER NOT NULL,
  UNIQUE(uri, subtrack_index)
) STRICT;
```

Plus `albums` (stable id, derived `match_key`, `pinned` — see §17.1), `values_` + `track_values`
(interned multi-value fields), `track_extras` (user-defined and long-form fields, so a new field
never means `ALTER TABLE` on a huge table), `media_tags` (raw per-source tags, so two files backing
one track can disagree without the disagreement being lost), `tracks_fts` (contentless FTS5),
`play_history`, `tag_writes` (the undo journal), `playlists`, `roots`, `settings`.

Settings: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `STRICT` tables throughout.

### 3.5.2 Field storage kinds

A field descriptor's `storage` determines how both compilers reach it:

| Storage | Location | Filter semantics |
|---|---|---|
| `column` | a column on `tracks` | direct comparison |
| `computed` | a SQL expression | direct comparison; the in-memory index materializes it |
| `multi` | `track_values` + `values_` | set semantics: any / all / none / count |
| `extra` | `track_extras` | direct comparison; for user-defined and long-form fields |
| `media` | a column on `media` | **matches when ANY of the track's media matches** |

The `media` kind is what makes "I have this in FLAC" and "show me everything under /music/live"
behave correctly on a track that has several sources. Sorting and grouping on a `media` field use
the preferred source (`quality_rank DESC, id`).

### 3.5.3 No in-memory index (and when to build one)

Earlier drafts specified a columnar in-memory mirror — typed-array columns, roaring bitmaps per
interned value, a `SharedArrayBuffer` handoff from a worker — because a 250k-track target demanded
it. **At the 50k target that machinery is unnecessary, and it is therefore not in v1.**

The measurements in §12 are the argument: SQLite answers a compound filter over 50k tracks in 32 ms
and a filter-pane group-by in 33 ms, both well inside a 100 ms interactive budget. Building a second
copy of the library in memory to beat numbers already three times under budget would be pure cost —
a synchronization surface, a memory footprint, a class of bugs where the two representations
disagree, and a worker protocol to maintain.

**Build one when, and only when**, a real library misses a §12 budget. The trigger is a measurement,
not a hunch. The work is scoped and the seam already exists: `src/main/query/evaluate.ts` is a
complete native predicate over an `IndexedTrack` shape, so an index would supply data to an
evaluator that is already written and already tested against SQL.

### 3.6 Ratings

Stored 0–100 (integer), `NULL` = unrated. Displayed as 5 stars, half-stars optional per user setting
(half-star mode maps to the 0/10/20/…/100 grid; full-star mode to 0/20/40/60/80/100).

Interop mapping, written to files only when "sync stats to tags" is on:

| Anthem | POPM (ID3v2) | FMPS_Rating | Stars |
|---|---|---|---|
| null | tag absent | tag absent | — |
| 0 | 0 | 0.0 | 0 |
| 20 | 1 | 0.2 | 1 |
| 40 | 64 | 0.4 | 2 |
| 60 | 128 | 0.6 | 3 |
| 80 | 196 | 0.8 | 4 |
| 100 | 255 | 1.0 | 5 |

POPM reads are bucketed on the inverse of this table (the Windows Media / Banshee convention), and
`FMPS_Rating` wins over `POPM` when both exist because it is unambiguous.

---

## 4. Query engine

### 4.1 Filter AST

One JSON representation serves saved filters, smart playlists, the search bar, and the browser
panes. It has exactly two node kinds.

```jsonc
{ "op": "and", "children": [
    { "field": "rating",     "op": ">=",       "value": 80 },
    { "field": "genre",      "op": "any",      "value": ["Jazz", "Blues"] },
    { "field": "last_played","op": "not_in_last", "value": { "n": 30, "unit": "day" } },
    { "op": "or", "children": [
        { "field": "year",   "op": "between",  "value": [1955, 1969] },
        { "field": "tags",   "op": "any",      "value": ["essential"] }
    ]},
    { "op": "not", "children": [ { "field": "path", "op": "under", "value": "/music/live" } ] }
]}
```

Operator set is a superset of gmusicbrowser's, so its filter strings import 1:1:

| gmb | Anthem | | gmb | Anthem |
|---|---|---|---|---|
| `e` | `is` / `=` | | `h` | `top` (top N by field) |
| `-e` | `not_is` / `≠` | | `t` | `bottom` |
| `>` `<` | `>` `<` | | `~` | `regex` |
| `-<` `->` | `>=` `<=` | | `s` | `starts` |
| `b` | `between` | | `c` | `contains` |
| `-b` | `not_between` | | `defined` | `defined` |

Plus Anthem additions: `any` / `all` / `none` / `count` for set fields, `in_last` / `not_in_last` for
dates, `matches` for FTS, and `in_playlist` / `in_filter` for composition (a smart playlist may
reference another by id — cycles are detected at save time and rejected).

### 4.2 Two compilation targets

The same AST compiles to:

1. **Parameterized SQL** — the primary path. Every list, pane, count and saved playlist is answered
   by SQLite, which at the §12 target is fast enough that nothing else is needed.
2. **A native predicate** (`evaluate.ts`) — answers *"does this one track match this filter?"*
   without a database round trip.

The second target is not a performance shortcut any more; dropping the 250k target removed that
justification (§3.5.3). It earns its place on a different job: **live membership**. A smart playlist
marked `refresh: 'live'` must react when a track is rated, played, skipped or retagged. Re-running
every live filter as SQL on every such event is wasteful and gets worse as saved playlists
accumulate; evaluating the changed track against each filter in memory is a handful of comparisons.
The same mechanism serves queue auto-fill (§8.2) and "is the playing track still in the current
view?".

Both paths are held to the same standard: for a generated corpus and a generated AST, they must
return identical id sets (§13.1). That test is what makes it safe to have two implementations of the
same semantics at all — and it has already caught one divergence that would have silently dropped
tracks from negated filters.

### 4.3 Smart playlists

A smart playlist = filter AST + sort spec + optional limit + refresh policy.

```jsonc
{
  "id": "sp_neglected_gems",
  "name": "Neglected Gems",
  "filter":  { "op": "and", "children": [
      { "field": "rating", "op": ">=", "value": 80 },
      { "field": "last_played", "op": "not_in_last", "value": { "n": 6, "unit": "month" } }
  ]},
  "sort":  [ { "field": "rating", "dir": "desc" }, { "field": "random", "seed": "session" } ],
  "limit": { "count": 100, "by": "tracks" },   // or by: "duration" / "filesize"
  "refresh": "live",                            // live | on_open | manual
  "dedupe": { "by": "mb_recording_id", "keep": "highest_bitrate" }
}
```

`sort` supports a `random` pseudo-field with a seed policy (`session`, `daily`, `fixed:<n>`), and a
`weighted_random` pseudo-field taking a weight expression — this is how gmusicbrowser's excellent
"play what I like but haven't heard lately" shuffle gets reproduced:

```jsonc
{ "field": "weighted_random",
  "weight": "(rating ?? 50) * pow(0.5, days_since(last_played) < 30 ? 2 : 0)" }
```

### 4.3.1 Multi-key sort, and sorting as a way to build a playlist

**The mechanism exists today.** `SortState` in `shared/view.ts` holds an ordered list of sort keys,
shift-clicking a column header appends one rather than replacing it, and the header shows its
position in the order. `compileFilter` emits every key into the `ORDER BY`, with NULLs last in both
directions. Sorting by album, then disc, then track is the default view.

What follows is the part still to build.

#### 4.3.1.1 Sort as a first-class, editable object

Column-clicking is fine for two keys and awkward for four. The sort order should also be editable
directly: a small panel listing the active keys in order, each row draggable, with a direction
toggle and a remove control, plus an add-key picker over every sortable field. The same object is
what a layout document already stores (§5.1) and what a smart playlist already carries (§4.3), so
this is one editor serving three places.

```jsonc
"sort": [
  { "field": "rating",      "dir": "desc" },
  { "field": "play_count",  "dir": "desc" },
  { "field": "last_played", "dir": "asc" },
  { "field": "album" }, { "field": "disc_number" }, { "field": "track_number" }
]
```

#### 4.3.1.2 Sorting into a smart playlist

This is the useful idea, and it is nearly free. A smart playlist is already *filter + sort + limit*
(§4.3), and a browse state is already a filter AST (§6.3). So **"save this view as a smart
playlist"** needs no new query machinery — it serializes what the user is already looking at:

> Filter panes narrowed to `genre: Jazz`, sorted by rating desc then last-played asc, limited to
> 100 tracks → *"Best jazz I haven't heard lately"*, live-refreshing.

The button belongs next to the sort editor and next to the filter stack, because from the user's
point of view those two together *are* the playlist definition. The limit is the only field the
dialog has to ask for, and `by: "duration"` makes "two hours of this" a one-click playlist.

Design notes that matter:

- **A limit without a sort is a bug**, not a feature: "100 tracks" from an unordered set is
  arbitrary and changes between runs. The dialog should require a sort, defaulting to the current
  one, and offer `random` explicitly when arbitrary really is what is wanted.
- **Sort direction carries meaning for NULLs.** "Least recently played" must include never-played
  tracks, and Anthem's NULLs-last rule puts them at the wrong end. The sort editor needs a
  per-key *nulls first / last* choice before this feature is honest.
- `weighted_random` (§4.3) is a sort key like any other, so the same editor produces gmusicbrowser's
  best shuffle behaviour without a separate UI.

#### 4.3.1.3 Grouping is the same object

The SongTree's grouping (§6.1) is a prefix of the sort: grouping by album *is* sorting by album
first. Treating them as one thing means "group by artist, then album, then sort by track" is
expressible without a second concept, and a grouped view saves to a playlist identically.

#### 4.3.1.4 What is needed

1. Per-key `nulls: 'first' | 'last'` in `SortKey`, honoured by `compileFilter` and `evaluate`.
2. A sort editor component driven by `SortState`, with drag reordering.
3. `saveAsSmartPlaylist(filter, sort, limit, name)` plus its IPC channel and dialog.
4. Tests: multi-key ordering against real data, NULL placement in both directions, and a round-trip
   asserting a saved playlist returns exactly the rows the view showed.

### 4.4 The search bar

A single input parses a "smart string" into an AST — gmusicbrowser's `smartfilter` idea, generalized:

```
beatles                      → FTS across searchable fields
artist:beatles               → artist contains "beatles"
artist="the beatles"         → exact
rating:>3                    → rating >= 60  (star-aware: numbers ≤5 on a rating field mean stars)
year:1965..1970              → between
genre:jazz,blues             → genre has any of
-live                        → NOT (FTS "live")
played:<30d                  → last_played in last 30 days
added:>2024-01-01            → added after
bpm:120..130 rating:>=4      → implicit AND
```

Parse errors never block: the bar shows what it understood as removable chips, and unparseable text
degrades to a plain FTS term.

---

## 5. Layout and customization

### 5.1 The premise

gmusicbrowser's real superpower is that the window is a document, not a program. Anthem keeps that
and puts it in a format people already know how to edit.

A layout is a JSON document describing a tree of nodes. Nodes are either **containers** (split, tabs,
stack, grid, toolbar, overlay) or **widgets** from the registry. Every node has an `id`, a `type`,
`props`, and optional `style`.

```jsonc
{
  "id": "halon-default",
  "name": "Halon",
  "extends": null,
  "window": { "min": [900, 560], "default": [1400, 900] },
  "root": {
    "type": "split", "dir": "vertical", "sizes": [1, "auto"],
    "children": [
      { "type": "split", "dir": "horizontal", "sizes": ["260px", 1],
        "children": [
          { "type": "sidebar", "id": "nav",
            "props": { "sections": ["library", "playlists", "smart", "filters", "queue"] } },
          { "type": "split", "dir": "vertical", "sizes": ["auto", 1],
            "children": [
              { "type": "filterpanes", "id": "browser",
                "props": { "panes": [
                    { "field": "genre",       "width": 200 },
                    { "field": "album_artist","width": 260 },
                    { "field": "album",       "width": 260, "art": true }
                ]}},
              { "type": "songlist", "id": "main",
                "props": {
                  "columns": ["track_number", "title", "artist", "album", "year",
                              "length", "rating", "play_count"],
                  "group_by": null, "sort": [{ "field": "album" }, { "field": "disc_number" },
                                             { "field": "track_number" }]
                }}
            ]}
        ]},
      { "type": "toolbar", "id": "player", "props": { "items": [
          "prev", "playpause", "next", "stop",
          { "type": "cover", "size": 56 },
          { "type": "nowplaying", "format": "{title}\n{artist} — {album}" },
          { "type": "seekbar", "props": { "waveform": false } },
          { "type": "stars" }, "spacer", "volume", "queuebutton", "menu"
      ]}}
    ]
  }
}
```

### 5.2 Widget registry

Every widget declares a manifest: id, display name, accepted props (JSON Schema), the data channels
it subscribes to, and its default size constraints. The layout editor is generated from these
manifests — no widget is special-cased in the editor.

**v1 widgets:** `songlist`, `songtree` (grouped/nested list with album headers), `filterpanes`,
`albumgrid`, `artistgrid`, `queue`, `playlistlist`, `sidebar`, `toolbar`, `seekbar`, `volume`,
`cover`, `artistimage`, `nowplaying`, `stars`, `lyrics`, `taginfo`, `statusbar`, `searchbar`,
`filterchips`, `visualizer`, `contextpanel` (tabbed: lyrics / artist bio / related / album tracks),
`buttonbox`, `spacer`, `label` (with the format-string language, §5.5).

### 5.3 Layout editing

Three levels, all reaching the same document:

1. **Direct manipulation** — drag panel edges, drag widgets between containers, right-click a column
   header to add/remove/reorder columns. Changes write straight to the layout JSON.
2. **Layout inspector** — a tree view of the document with a property grid generated from the widget
   manifest. Shows the JSON alongside, editable, with live validation.
3. **The file** — layouts live at `~/.config/anthem/layouts/*.json` and hot-reload on save. This is
   the escape hatch that makes power users happy and makes layouts shareable as a gist.

Layouts support `extends`: a layout may inherit another and patch nodes by id (RFC 6902-style
patches). Shipping a "Halon + big album art" variant is then a 10-line file.

### 5.3.1 Remembered view settings

View settings persist per user rather than resetting on every launch: theme, density, the merge
view's *Only differences* toggle, the duplicate finder's strategies and tolerance, split-pane sizes,
**the sort order, the active filters, the search term, and which field each filter pane shows**.

Remembered *browse state* needs more care than a remembered toggle, because it can outlive what it
names. A sort key or a pane selection referring to a field that no longer exists would either break
the view or silently narrow the library to nothing with no visible cause. So `shared/viewstate.ts`
validates everything restored against the current field catalogue and drops what it cannot
recognise, and restored filters are rebuilt **as visible chips** rather than applied invisibly — the
user can see why the library is narrowed, and clear it.

The parsing lives in `src/shared/prefs.ts`, apart from any framework, because the interesting case
is not the happy path — it is a stored value that is corrupt, left over from an older version, or of
the wrong shape. **A bad stored value must never break the view it belongs to**, so every read falls
back to the default when the JSON is unparseable, fails its validator, or no longer matches the
default's type. Storage being unavailable entirely is handled the same way. `test/unit/prefs.test.ts`
covers each of those cases.

These are deliberately *not* in the library database. They are per-machine view state, not library
data, and putting them in SQLite would mean they travelled with a library export where they do not
belong. Settings that describe the library — watched roots, read-only mode — do live in the
database.

### 5.4 Theming

Themes are **token documents**, not stylesheets. Halon's `tokens.json` is the reference input and its
schema is Anthem's schema — same names, same light/dark split:

```
accent · border-{control,default,focus,hover} · focus-ring
shadow-{base,card,floating,item,modal,tab}
status-{danger,success,warning,warning-text}
surface-{default,navigation,navigation-hover,overlay,root,secondary}
text-{body,heading,on-fill,on-light,on-navigation,secondary,tertiary}
```

Anthem adds a small player-specific layer on top, derived by default but overridable:

```
media-progress · media-progress-track · media-buffer
rating-on · rating-off · rating-hover
waveform-played · waveform-unplayed
row-{even,odd,hover,selected,selected-inactive,playing}
column-header · column-separator · drag-indicator
```

At runtime the token document becomes CSS custom properties on `:root`, with `data-theme` switching
light/dark and `prefers-color-scheme` as the default signal. Every widget styles itself from tokens
only — a lint rule (borrowed in spirit from Halon's `scripts/lint-gtk.mjs`) fails CI on any raw hex
in a component stylesheet.

Themes ship as a directory: `theme.json` (tokens) + optional `theme.css` (overrides) + optional
assets. Halon-Light and Halon-Dark ship in-tree, generated from Halon's own `tokens.json` so they
stay in sync with the upstream repo at `Coding/TechNet/Halon`.

Metric tokens (spacing scale, radii, control heights, density modes) follow Halon's
`THEME-DESIGN-GUIDE.md` §4 rather than being reinvented — including its three density levels, which
map cleanly onto compact/normal/comfortable row heights in the song list.

### 5.5 Format strings

One tiny language used by `label`, `nowplaying`, tooltips, tray text, notification text, the file
renamer, and column custom formats:

```
{title}                       field
{artist|album_artist}         first non-empty
{year:%04d}                   format spec
{length:m:ss}                 duration format
{rating:stars}                 typed renderer
[{disc}.]{track}. {title}     bracketed groups vanish if any field inside is empty
{genre:join(", ")}            set field join
{path:basename}               transforms: basename, dirname, ext, upper, lower, title, pad(n)
```

The renamer/organizer reuses it exactly: `{album_artist}/{year} - {album}/[{disc}.]{track:%02d} - {title}`.

---

## 6. Interaction and views

### 6.1 Song list

Virtualized, 250k rows, 60 fps scroll. Non-negotiable behaviours:

- Column add/remove/reorder/resize from the header context menu; every filterable field is available
  as a column.
- Multi-key sort (shift-click to add a sort key), sort indicator shows priority.
- Grouping mode (SongTree): group by any field, sticky group headers with album art, per-group
  aggregate row (count, total duration).
- Selection: range, toggle, invert, "select all in group", keyboard-first. Arrow keys move a
  cursor, shift extends the range from the anchor, ctrl+shift extends without discarding what is
  already selected, and ctrl alone moves the cursor without disturbing the selection. Home, End,
  Page Up and Page Down move by list and by page; Ctrl+A selects all; Escape clears.

  **A range replaces rather than accumulates.** That is what lets shift+arrow shrink again when the
  direction reverses, and it matches what a range-click does everywhere else; `range-add` exists for
  ctrl+shift, where keeping the existing selection is the point. The anchor stays put across
  extensions, so every one measures from the same origin instead of creeping.
- Inline rating (click the star position), inline field edit on slow double-click for editable
  string fields.
- Drag to queue, to playlist, to another app (URI list), from the filesystem in.
- Row context menu is user-configurable (an action list in the layout document).

### 6.2 Filter panes

The gmusicbrowser browser panes, kept: N stacked or side-by-side lists, each grouping the current
result set by a field, each selection narrowing the next. Additions: pane field is switchable inline,
panes show counts and aggregate duration, multi-select within a pane is OR, across panes is AND, and
the whole pane state is expressible as — and round-trips to — a filter AST, so any browse state can
be saved as a smart playlist with one click.

### 6.3 Filter stack

The active query is a visible stack of chips: `Library → genre: Jazz → rating ≥ 4 → "coltrane"`.
Each chip is removable and reorderable; the stack is the AST. This replaces the "where did this view
come from?" confusion that browse-by-panes normally causes.

### 6.5 Song properties — implemented

A dedicated view for everything Anthem knows about one track. This is the first place the entity
model becomes visible to the user, and it is the natural home for several features that currently
have nowhere to live.

**Sections:**

1. **Identity** — title, artist, album, and *how the track was identified*: `identity_source`
   (`manual` / `mbid` / `acoustid` / `audio_hash` / `heuristic`), `identity_key`, and whether it is
   `pinned`. A user who wonders "why are these one track?" should find the answer here.
2. **Sources** — the point of the panel. One row per `media`, showing:
   - path or provider URI, and whether the file is currently `present`
   - codec, bitrate, sample rate, channels, bit depth, file size, modification time
   - `audio_hash` and which algorithm produced it, so `sha256-file` (weaker, changes on retag) is
     distinguishable from `flac-streaminfo-md5` at a glance
   - `subtrack_index` / `start_ms` / `end_ms` when the source is a range inside a container
   - which source is preferred for playback, and why (`quality_rank`)
   - per-source actions: reveal in file manager, copy path, prefer this source, forget this source
3. **Tags** — the raw per-source tags from `media_tags`, shown *side by side when sources
   disagree*. Two files backing one track can carry different tags, and §3.5.1 already stores both
   rather than losing the disagreement; this is where that becomes useful.
4. **Statistics** — rating, play and skip counts, first and last played, and the full play history
   as a small timeline. These belong to the track, not the file, which the panel should make
   evident.
5. **Merge provenance** — if the track was merged, what it absorbed and a link to undo it (§9.4.3).

**Why it is worth doing early:** every question a user asks about the entity model ("where are my
files?", "which copy plays?", "is this one track or two?", "did my rating survive?") is answered by
this one view. It is also read-only, so it carries none of the risk of the tag editor.

`src/main/library/details.ts` gathers it; `SongProperties.tsx` renders it as a full-screen view
reached from the song list (select one track, then Properties, or Alt+Enter).

Four sections: **Overview** (metadata, identity, statistics, loudness, merge provenance),
**Sources**, **Raw tags** per source, and **History**.

Two things it does that a plain field dump would not:

- **It explains itself.** `identity_source` is rendered as a sentence — "Grouped by its path and
  tags; no stronger evidence was available" — and each `audio_hash_algo` says what it implies, so
  `sha256-file` is visibly weaker than `flac-streaminfo-md5` rather than being an opaque string.
- **It marks which source actually plays**, using the same ordering the player uses, so "which copy
  am I hearing?" has an answer rather than an inference.

Still to do: album and artist artwork (§7.3), which is not implemented anywhere yet.

### 6.4 CSS baseline

Because three WebView engines: no `:has()` in load-bearing positions (WebKitGTK lag), no container
queries in v1, `content-visibility` behind a capability check, subgrid avoided. Virtualization is
transform-based (`translate3d` on a spacer), not `position: absolute` per row. Scrollbar styling via
`scrollbar-width`/`scrollbar-color` with a `::-webkit-scrollbar` fallback.

---

## 7. Tag management

### 7.0 Read-only mode

**Anthem starts read-only and stays that way until told otherwise.** A music library is often
irreplaceable, and the failure mode of a tag writer with a bug is silent, widespread and permanent.

Enforcement is a chokepoint, not a convention: every filesystem-mutating operation passes through
`assertWritable(operation, path)` in `src/main/safety.ts`, which throws unless the path lies inside
Anthem's own data directory. Tag writing, file organizing, artwork embedding and deletion are all
downstream of it, so a new call site cannot forget to check.

- Default: read-only. A missing or malformed `ANTHEM_ALLOW_WRITES` keeps protection on.
- `ANTHEM_FORCE_READ_ONLY=1` pins the mode so the UI cannot disable it at all.
- The state is surfaced in the menu bar, not buried in preferences.
- `scripts/run.sh` pins read-only unless the caller explicitly opts out.

Covered by `test/unit/safety.test.ts`, including that a sibling directory such as
`~/.config/anthem-backup` is not mistaken for Anthem's own data directory.

### 7.1 Reading and writing

`lofty-rs` is the tag layer: ID3v1/v2.2–2.4, Vorbis comments (FLAC/Ogg/Opus), MP4 `ilst`, APE,
WavPack, WAV/AIFF chunks, plus MP3/AAC/FLAC/Opus/Vorbis/ALAC/WavPack/APE/AIFF/WAV properties.
Module formats (`.mod`, `.xm`, `.it`, `.s3m`) get metadata via a small dedicated reader.

Writing rules:

- **Never** rewrite a file that has no pending changes. Tag writes are explicit, batched, and
  transactional per-file (write to temp, fsync, rename).
- Preserve unknown frames byte-for-byte. Anthem is not allowed to lose a tag it does not understand.
- ID3v2.4 + UTF-8 is the default target for MP3; existing v2.3 files stay v2.3 unless the user opts
  into upgrading.
- A dry-run diff view before any mass write, showing per-file before/after per-field.
- Every write is journaled (`tag_writes` table) with the prior value, so a mass edit is undoable for
  N days.

### 7.1.1 MusicBrainz Picard integration

Anthem is not going to out-Picard Picard (§1.1). Picard has acoustic fingerprinting, the full
MusicBrainz release model, a plugin ecosystem and years of edge-case handling for exactly the job of
*deciding what a file is*. Reimplementing that would be a bad use of the project's time and would be
worse at it.

So the position is: **Anthem owns the library; Picard owns authoritative tagging.** The integration
makes them cooperate rather than compete.

#### 7.1.1.1 What it looks like

Three levels, in increasing order of effort.

**1. Hand off a selection (small, high value).** A context-menu action that launches Picard with the
selected tracks' files as arguments — Picard accepts file and directory paths on the command line.
The user tags in Picard, saves, and returns; Anthem rescans just those paths and picks up the
changes. The path to the Picard binary is a setting, discovered from `PATH` by default. This is
close to free and covers most real use.

**2. Notice what Picard did (the part that needs care).** Picard *writes* files, which collides with
two of Anthem's invariants:

- **Read-only mode (§7.0) does not protect against this** — the writes come from another process.
  That is fine and intended, but the UI must say so plainly: handing off to Picard means files will
  be modified by a tool that is not bound by Anthem's read-only setting.
- **`audio_hash` is unaffected**, because it excludes metadata regions (§3.5). This is where that
  decision pays off: a Picard retag changes `mtime` and `filesize` but not the audio, so the rescan
  matches the existing media by hash, and **ratings and play history survive tagging**. A
  path-keyed design would have coped too, but a design keyed on whole-file digests would have
  orphaned every retagged file.
- If Picard *renames or moves* files, which it does by default when configured to, the rescan sees
  a disappearance plus an arrival with a matching hash — already handled as a move (§9.1).

**3. Read MusicBrainz identifiers directly (later).** Once files carry `musicbrainz_recordingid`,
the duplicate finder promotes those tracks to `certain` confidence (§9.2) and identity resolution
gains its strongest signal (§3.5.0). The scanner already reads the tag; nothing more is needed.

#### 7.1.1.2 What Anthem should *not* do

- **Not embed Picard**, and not reimplement AcoustID lookup (§3.5 explains why AcoustID is a hint,
  not a key).
- **Not sync back to MusicBrainz.** Submitting edits is Picard's job and carries community
  responsibilities Anthem should not take on.
- **Not fight Picard over file layout.** If a user lets Picard rename files, Anthem follows via move
  detection rather than trying to own the naming.

#### 7.1.1.3 What is needed

1. A `picard` setting: binary path, plus whether to rescan the affected paths on return.
2. A "Tag with Picard" action on a track selection and on an album.
3. A targeted rescan — `scanRoots` already takes a root list, so scanning specific paths is a small
   generalization.
4. A clear warning in the hand-off dialog that Picard writes to files regardless of read-only mode.

### 7.2 Mass tagging

- Select N tracks → edit any field; mixed values show as `<multiple>` and stay untouched unless set.
- Find/replace across a field, with regex and capture groups, previewed.
- **Tags from filename**: pattern `{album_artist}/{album}/{track} - {title}` matched against paths,
  with a preview table and per-row opt-out.
- **Filename from tags**: the same format language (§5.5), with collision detection, a
  copy-vs-move-vs-hardlink choice, and empty-directory cleanup.
- Auto-numbering, case transforms (title case with a configurable exception list — "of", "the",
  "feat."), whitespace normalization, `artist` splitting on configurable separators
  (`;`, `/`, `feat.`, `&`) with an allow-list for names that legitimately contain them.
- Album-level operations: set album artist from most common artist, mark as compilation, fix disc
  numbering, embed cover art in all tracks.

### 7.3 Artwork — implemented

`src/main/library/artwork.ts`. Sources in priority order: **embedded picture → folder image**. A
remote fetch is a later plugin (§11).

- **Art belongs to the album where there is one, and to the track otherwise**, so every track on an
  album shares one lookup and a loose single still gets a cover.
- **Resolution is lazy.** Nothing is extracted until something wants to display it, which keeps a
  scan fast and avoids decoding images nobody will see.
- **A miss is recorded**, with source `none`. Without that, a coverless track would be searched —
  folder listing included — on every single play. `art:rescan` clears only the misses, so a newly
  added cover is picked up without discarding real entries.
- **The cache is content addressed** by the image's own hash, so an album art file duplicated across
  a hundred folders is stored once.
- **Folder matching is deliberately loose**: `cover`, `folder`, `front`, `album`, `albumart`,
  `thumb`, `artwork`, any case, any image extension. A folder holding exactly one image is taken as
  the cover; a folder holding several unnamed images is not guessed at.
- Image dimensions are read from the file header rather than by decoding, so knowing the size costs
  nothing.

**Serving it to the renderer** needed its own scheme. The renderer runs under a strict CSP and
cannot load `file://`, so cached art is served over `anthem-art://`, registered as a privileged
scheme and restricted to paths inside the cache directory — a url pointing anywhere else is refused
rather than read.

**Thumbnails** are generated on demand at 64, 128, 256 and 512 px, and a request is served by the
smallest size that is large enough. An image already no bigger than what was asked for is served as
it is, because upscaling a small cover wastes space and looks worse than letting the layout scale
it. Resizing goes through Electron's own image support rather than adding a native image library,
and `artwork.ts` takes the resizer as an argument so it stays testable without Electron.

Still to do: artist images, and the remote fetch.

**Measured on a real 5,079-track library:** 5 of a 25-track sample carried embedded art. That
library is organised into folders by rating rather than by album, so the folder-image fallback finds
nothing — which is a fair illustration of why embedded art is tried first.

### 7.4 Stats sync

Play counts, ratings, and labels can optionally write back to files as `FMPS_*` / `POPM` so the
library survives a database loss and interoperates with other players. Off by default (it means
touching every file you rate); when on, writes are deferred and coalesced.

---

## 8. Playback

### 8.0 What is implemented

`src/main/play/` — an engine interface, an mpv backend, and a player that owns every decision.

The split is the point: **`player.ts` knows nothing about audio.** Which of a track's media to use,
when a play counts, how the queue drains against the standing list, what repeat and shuffle mean —
all of it sits behind `PlaybackEngine` and is tested against a fake engine, so 24 tests cover
playback behaviour without spawning a process or making a sound.

Decisions worth recording:

- **A play counts at half the track, or four minutes, whichever comes first.** Below that, a track
  abandoned after at least three seconds counts as a skip; less than three seconds counts as
  neither, because changing your mind before it starts is not a skip.
- **A track settles exactly once.** The first version double-counted skips, because both `next()`
  and `playTrack()` recorded one. Play, skip, or neither — never two.
- **Seeking backwards cannot fake a second play**: the threshold is measured against the furthest
  point reached, not the current position.
- **The best source that is actually there wins.** Existence is checked rather than trusted: a
  library imported from elsewhere is full of rows whose files have since moved or gone, and handing
  one to the engine produces "loading failed", which tells the listener nothing. The player skips
  absent sources, marks them absent as it goes — so the library corrects itself as it is used — and
  distinguishes *"the file for this track is missing"* from *"this track has no file"*, because the
  fix differs. On the test library this mattered for **2,465 of 5,079 tracks**.
- **Repeat one ends where it began, but a manual skip still moves on.** Repeating a track forever
  because the listener pressed Next would be obtuse.
- **Previous restarts the track first** if more than three seconds in, as every other player does.
- Shuffle is a seeded permutation, so an order is reproducible and testable; a new pass through a
  shuffled list reseeds rather than repeating the same order.

### 8.0.1 Three defects the fake engine could not have caught

Playback shipped broken, and the fake-engine tests all passed while it was. Worth recording why.

1. **A start-up deadlock.** `command()` waited on a `ready` promise, and the setup commands ran
   *inside* the function that resolves `ready` — so start-up waited for itself. Every call hung
   forever rather than failing. Fixed by separating a raw `send()` used during start-up from the
   gated `command()` used after it.
2. **The wrong `loadfile` argument slot.** mpv 0.38 added an insert index, making the signature
   `loadfile <url> <flags> <index> <options>`. Anthem passed its options string where the index
   goes, which mpv rejects as `invalid parameter`; an empty options string is rejected too, so the
   argument list has to be built rather than padded.
3. **A shared IPC socket path.** It was keyed on the process id, so two engines in one process
   collided — invisible in the app, fatal in tests.

The lesson is not "write more unit tests". It is that **a boundary can only be verified by crossing
it**: the fake engine proves the player's decisions, and only a real mpv proves the engine. There is
now an integration test that plays a real file from a real library and asserts the position
advances, which is what should have existed before playback was called done.

### 8.1 Engine

A `PlaybackEngine` interface with a default **mpv** implementation, driven over mpv's JSON IPC
socket as a subprocess rather than by linking libmpv — which keeps the native dependency surface at
zero, matters more in an Electron app than it would in a Rust one, and costs only a socket.

If mpv is missing, the app still runs: the library works and the player reports that audio is
unavailable, rather than failing at the first click.

Original reasoning, unchanged: mpv is chosen for the same reason
gmusicbrowser eventually added an mpv backend: it already solves gapless, format coverage
(everything, including exotic and module formats), ReplayGain application, precise seeking, and
output backend selection (PipeWire/PulseAudio/ALSA/CoreAudio/WASAPI) — problems that are unglamorous
and enormous to re-solve.

A second implementation — `symphonia` decode + `cpal` output — is planned for a dependency-free build
and for platforms where bundling mpv is awkward. The trait keeps this a swap, not a rewrite. Format
coverage differences are surfaced in the UI, not hidden.

### 8.2 Features

- Gapless playback with pre-buffered next track; crossfade with configurable curve and per-transition
  override (no crossfade within an album's gapless boundary).
- ReplayGain and EBU R128: read from tags, apply track or album gain per user preference, with a
  preamp and a clipping-prevention limiter. Built-in scanner (`bs1770` / `ebur128`) for untagged
  files, run as a background batch job.
- Queue that is genuinely separate from the playlist (gmusicbrowser's model): the queue is a
  transient list that drains; the playlist is the standing context. "Play next", "queue album",
  "queue and clear".
- Repeat: off / all / one / album. Shuffle: off / tracks / albums / weighted (§4.3).
- **Auto-fill**: when the queue empties, append N tracks from a chosen filter — this is what makes
  gmusicbrowser feel like a radio you programmed.
- Locks: lock to current artist / album / genre / filter, so shuffle stays inside a set.
- Bookmarks and resume-on-launch for long tracks (audiobooks, mixes, DJ sets).
- Per-track and global equalizer (10-band), off by default.
- Playback speed and pitch for spoken-word content.

### 8.3 Events

The core emits a typed event stream to the renderer: `state`, `position` (throttled to 10 Hz,
interpolated in the UI to avoid a 60 Hz IPC firehose), `track_changed`, `queue_changed`,
`library_changed(delta)`, `scan_progress`, `error`. The renderer never polls.

---

## 9. Library management

### 9.1 Scanning — implemented (watching is not)

`src/main/library/scan.ts`. Reads only: files are opened for tag parsing and hashing, and nothing in
the scanner writes to the music tree.

What works today:

- Multiple roots, added through Settings → Folders, with a progress-reporting scan.
- Tag reading via `music-metadata`, which is **read-only by construction** — a good fit for the
  read-only posture in §7.0, and it defers the tag-writer decision (Appendix A.3) entirely.
- **Unchanged files take a cheap path**: a matching `uri` + `mtime` + `filesize` skips parsing and
  hashing altogether, which is what makes a rescan fast.
- **Move detection** via `audio_hash`: a renamed file keeps its track, rating and play history.
- **Missing files are flagged, never deleted** — and only media *under a scanned root* is
  considered, so unplugging one drive does not mark another library missing.
- Unreadable files are collected as errors rather than aborting the scan.
- Writes are batched 200 files per transaction; a cancel flag stops the walk between files.

Still to do:

- **Filesystem watching** (`chokidar` or `fs.watch`) for live updates; today a rescan is manual.
- **Include/exclude globs** per root; only a default directory exclusion list exists.
- **The `slow` flag** for network mounts is in the schema and honoured by `scanRoots`, but is not
  yet settable in the UI.
- Running the scan in a **worker thread**. It currently runs on the main thread with batched
  transactions, which is acceptable at the §12 target but will block the UI on a very large first
  scan.

Original design notes, still applicable:
- Initial scan: parallel walk (`ignore` crate), per-file tag read on a rayon pool, batched inserts in
  one transaction per 5,000 files. Target: 100k files in under 4 minutes on an NVMe SSD.
- Incremental: `notify`-based filesystem watching with debounce; on startup, an mtime/size sweep
  catches changes made while closed.
- Moved-file detection via `content_hash` — a moved file keeps its rating and play count. This is the
  single most valuable thing a library manager can get right.
- Missing files are flagged, not deleted; a "missing tracks" view offers relocate/forget.
- Network mounts: a per-root "slow" flag that disables hashing and watching, using mtime only.

### 9.2 Deduplication — implemented

`src/main/library/duplicates.ts`. Proposes groups; never changes anything. Four strategies, each
carrying its own confidence and a sentence explaining itself, because a proposal the user cannot
evaluate is worse than none:

| Reason | Confidence | Basis |
|---|---|---|
| `audio_hash` | certain | Byte-identical audio content |
| `mb_recording_id` | certain | Same MusicBrainz recording |
| `tags` | likely | Same `identity_key`: artist, title and album, normalized |
| `fuzzy` | possible | Same artist and title, ignoring album, with durations within a tolerance. **Off by default.** |

Details that matter, all pinned by tests:

- **A track appears in one proposal at a time**, strongest evidence first, so the user is never
  asked about the same track twice in one pass.
- **Fuzzy matching splits a bucket by duration** (default tolerance 3 s, configurable), so a cover
  and the original do not merge on title alone.
- Normalization strips diacritics and `(feat. …)` suffixes, so *Café* by *Björk* groups with *Cafe*
  by *Bjork*.
- **Bracketed text is not stripped wholesale.** An earlier version removed anything in brackets,
  which collapsed `[Act 1]` and `[Act 2]` into one title — a wrong merge rather than a missed one.
  Only a fixed list of boilerplate is ignored (`[Official Video]`, `[No Copyright Music]`,
  `[Remastered]`, and similar). Found by running the finder against a real 5,132-track library,
  which is also why fuzzy is off by default: with it on, that library produced **1,903** fuzzy
  proposals — more than anyone will review, and a signal nobody would trust. With it off, the same
  library yields **21** actionable groups.
- A group spanning different albums says so in its explanation, because that is the case most
  likely to be a genuine second recording rather than a duplicate.

Each proposal offers two actions: **Review**, which opens the side-by-side diff (§9.4.1.1), and
**Quick merge**, which applies the defaults the preview already proposes — richest source survives,
multi-value fields union, statistics combine. Quick merge is only defensible because it is undoable:
the button is replaced in place by an **Undo** control rather than the merge disappearing into a
history view the user has to go find.

Still to do: rule-based keeper pre-selection (highest bitrate, preferred format, oldest added), and
a batch "merge every certain group" action — worth having, but it should report per-group outcomes
the same way the scan does (§9.1) rather than a single summary.

### 9.4 Merging tracks by hand — implemented

§3.5.0 deliberately refuses to guess that two different files are the same recording. That leaves a
gap the user has to be able to close: **select several tracks and merge them into one, choosing
which value to keep wherever they disagree.**

`src/main/library/merge.ts`, with `mergePreview`, `mergeTracks` and `unmerge`. Multi-select in the
song list, a merge dialog rendering the preview, and 20 tests including a full round-trip assertion
that unmerge restores tracks, media, statistics, history, sets, extras and playlist positions
exactly.

The reference is Thunderbird CardBook's duplicate merge: rather than picking a winning *record*, it
shows the conflicting *fields* side by side and lets the user resolve each one. That is the right
model here, because the correct answer is usually per-field — one file has the better title, another
has the year, a third has the genre.

#### 9.4.1 What a merge does

The survivor is one existing track; the others are absorbed and deleted.

| Thing | Behaviour |
|---|---|
| Media | All sources move to the survivor. This is the point: one track, several files. |
| Scalar fields | Per-field choice where sources disagree; identical values pass through silently. |
| Multi-value fields | Per-field choice of **union** (default) or one source's set. |
| Rating | Default: the highest. A deliberate rating should not be lost to an unrated duplicate. |
| Play count, skip count | Summed. They are counts of real events. |
| Play history | Union, deduplicated by the migration-002 constraint. |
| First played, added | Earliest. Last played, last skipped: latest. |
| Playlists | Entries repointed to the survivor, then deduplicated within each playlist. |
| Identity | Survivor gets `pinned = 1` and `identity_source = 'manual'`, so nothing re-splits it. |

#### 9.4.1.1 Full screen, side by side

Merging is a diff, and a diff needs width. The view is full screen with **one column per source and
one row per field**, so a disagreement reads as a comparison rather than as a list of options
detached from what it is being compared against. A trailing *Result* column shows what the survivor
actually ends up with as choices are made, so the outcome is never inferred.

- Clicking a cell picks that source's value for that field.
- *Take all from this* resolves every conflict from one source at once, for the common case where
  one record is simply better, and makes it the survivor.
- *Only differences* hides the fields that already agree, which on a real merge is most of them.
- Multi-value fields get a *Keep all* control in the Result column, because union is the default.

Settings uses the same full-screen frame. An earlier iteration made both modal dialogs after a
full-page settings view stranded a user with no obvious exit — but the problem was the missing exit,
not the format. The shared `Page` component now owns that: a persistent Close in the header and
Escape, so no caller can forget.

#### 9.4.2 The preview is the contract

`mergePreview(ids)` returns, for every field, the distinct values across the sources and which
track each came from — so the UI is a rendering of that structure rather than its own logic, and the
same preview can be unit-tested without a DOM.

```jsonc
{
  "survivor": 412,                       // proposed; the user may pick another
  "fields": [
    { "field": "title",  "conflict": false, "value": "So What" },
    { "field": "year",   "conflict": true,
      "options": [ { "from": 412, "value": 1959 }, { "from": 987, "value": 1997 } ] },
    { "field": "genre",  "conflict": true, "multi": true,
      "options": [ { "from": 412, "value": ["Jazz"] }, { "from": 987, "value": ["Jazz", "Modal"] } ],
      "union": ["Jazz", "Modal"] }
  ],
  "media": [ { "from": 412, "uri": "…/so-what.flac" }, { "from": 987, "uri": "…/so what.mp3" } ],
  "statistics": { "playCount": 31, "rating": 100, "note": "summed / highest" }
}
```

#### 9.4.3 Undo

A merge deletes rows, which makes it the most destructive operation in the app that does not touch a
file. It must be reversible: the whole pre-merge state of every absorbed track is written to the
existing `tag_writes`-style journal (or a sibling `merge_journal`) under one batch id, and
`unmerge(batchId)` restores it. **This is a prerequisite, not a follow-up** — shipping merge without
undo would be shipping a way to quietly lose ratings and history.

#### 9.4.4 Decisions taken while building it

- **The default survivor is the richest source** — most media, then most plays, then oldest added.
  A user may pick another, but the default should rarely need changing.
- **Union is the default for multi-value fields.** Keeping every genre is nearly always what was
  meant; taking one source's set is available but is the unusual choice.
- **Play history unions and deduplicates** via the migration-002 constraint. Events dropped as exact
  duplicates are recorded in the journal, so unmerge restores them rather than losing them
  permanently to a merge-and-undo cycle.
- **Repointing playlists can list the survivor twice** in one playlist; the merge keeps its earliest
  position and drops the rest.
- **Album is an entity, not a string**, so resolving the album field carries the chosen source's
  `album_id` rather than copying its name.
- **The survivor is pinned** (`pinned = 1`, `identity_source = 'manual'`), so no automated pass
  re-splits what a person joined.

Still to do: a merge-history view listing past merges with an undo control for each. `unmerge` works
and is tested, but is currently only reachable immediately after merging.

#### 9.4.5 Where it connects

The same preview and apply path serves the automated **duplicate finder** (§9.2): that feature's job
is to *propose* groups, and this feature's job is to *resolve* them. Building merge first means the
duplicate finder later only has to produce candidate id sets.

### 9.3 Import / export

- **gmusicbrowser importer — implemented** (`src/main/import/`). Reads `gmbrc` and imports library
  entries, ratings, play counts, skip counts, full play history, genres, groupings, labels and saved
  lists. The path defaults to the platform's standard location and can be overridden or browsed to.
  A preview parses without writing, so the user sees the counts before committing.

  Details that matter, all pinned by tests: gmusicbrowser stores rating 255 to mean *unrated*, which
  is not a rating of 255 and not a rating of 0; multi-value fields use a literal `\x00` separator
  (four characters, not a NUL byte); filesystem names are percent-encoded and a malformed escape
  must keep the value rather than lose it; timestamps are unix seconds against Anthem's
  milliseconds. Files gmusicbrowser flagged missing import as tracks with `media.present = 0`, so
  their ratings and history survive.

  The import is deliberately conservative: one track and one media per gmusicbrowser song, with no
  attempt to merge two files that may be the same recording. Deduplication is a separate reviewable
  operation (§9.2); silently merging someone's library on import would be the wrong default.

  Saved filters are counted and reported but not yet translated — gmusicbrowser filter strings map
  onto the filter AST, which is its own step.
- Playlist formats: M3U/M3U8, PLS, XSPF, CUE (read).
- Full export: library + stats + playlists as JSON, and a plain SQLite copy.
- iTunes XML and Rhythmbox XML import for ratings/play counts.

---

## 10. Integrations

- **MPRIS2** on Linux (full `TrackList` and `Playlists` interfaces, not just the minimum).
- **SMTC** on Windows, **MPNowPlayingInfoCenter** on macOS.
- Global media-key hotkeys, plus fully rebindable in-app keybindings (a JSON keymap file, same
  hot-reload treatment as layouts).
- Tray icon with a configurable menu and scroll-to-change-volume.
- Desktop notifications on track change, with album art.
- **Last.fm / ListenBrainz** scrobbling with an offline queue that survives restarts.
- A local HTTP control API (opt-in, loopback-only by default, token-authenticated) — this is what a
  future phone remote and CLI both talk to.
- A `anthemctl` CLI over the same API: `anthemctl play`, `anthemctl query 'rating:>=4 genre:jazz'`.

---

## 11. Plugins

Deferred past v1, but the seams are designed now so it is not a rewrite:

- **UI plugins**: a widget bundle (manifest + ES module) dropped in `~/.config/anthem/widgets/`,
  registering into the same registry as built-ins. Sandboxed to the renderer, no filesystem access
  except through declared IPC permissions.
- **Core plugins**: WASM components (`wasmtime`) implementing declared host interfaces — metadata
  provider, artwork provider, scrobbler, audio filter. WASM over native dylibs for the obvious
  safety and portability reasons.
- Everything Anthem ships that *could* be a plugin (lyrics fetch, artist bio, artwork fetch) is built
  as one, to keep the interfaces honest.

---

## 12. Performance budget

**The target library is 50,000 tracks.** That is roughly 3,300 albums — a large, seriously curated
collection, and comfortably above what most people accumulate in a lifetime of buying and ripping.

Designing for 250k was costing real complexity for a case almost nobody hits, and the measurements
below show why that trade was bad: at 50k, **plain SQLite with proper indexes meets every target
with no in-memory index at all** (§3.5.3).

| Operation | Library size | Budget | Measured |
|---|---|---|---|
| Cold start → interactive | 50k | 3 s | not yet measured |
| Filter — simple predicate | 50k | 100 ms | **3.7 ms** |
| Filter — compound (sets, dates, negation) | 50k | 100 ms | **32.3 ms** |
| Full-library scan | 50k | 100 ms | **17.0 ms** |
| Group-by for a filter pane | 50k | 100 ms | **28–33 ms** |
| Sort by any column | 50k | 150 ms | **77.4 ms** |
| Search keystroke → results | 50k | 60 ms | not yet measured |
| Scroll frame | any | 16 ms | — |
| Full scan | 50k files | 5 min | not yet measured |
| Track change (gapless) | any | 0 audible gap | — |
| Idle CPU (playing) | any | < 1% | — |
| Idle RSS (playing) | 50k | < 400 MB | not yet measured |
| Install size | — | ~150 MB | — |

Measured figures are means from `bench/query.bench.ts` on the development machine, over the
synthetic corpus in `test/helpers/corpus.ts`. Every query path has roughly 3× headroom against its
budget.

### 12.1 Above 50k: degradation, not a wall

Nothing in the design imposes a ceiling. SQLite with the indexes in §3.5.1 slows roughly linearly,
so a 150k-track library stays usable — filters in the low hundreds of milliseconds — without any
code change. What it does not get is a *budget*: those sizes are not optimized for, not benchmarked
in CI, and not a reason to reject a simplification.

If real libraries turn out to cluster higher than assumed, §3.5.3 describes the escape hatch and
§16 records the reversal trigger.

## 13. Testing

Vitest, with `fast-check` for property tests. Tests reach SQLite through Node's built-in
`node:sqlite` rather than `better-sqlite3`, so the suite never depends on which ABI the native
module was last rebuilt for — the SQL under test is identical either way.

### 13.1 The load-bearing test

`test/property/ast-agreement.test.ts`: for any generated filter over any generated library, the SQL
compiler and the native predicate must return **identical id sets**. Two implementations of one
semantics are only safe because this test holds them together — a live smart playlist that
disagreed with the list it was derived from would be a maddening bug to chase (§4.2).

It has already earned its place. It caught a three-valued-logic divergence: SQL's `NOT (year = 0)`
evaluates to NULL for a track with no year and therefore excludes it, while the native predicate
included it. The resolution is a decided semantic, not a patch:

> **Anthem uses two-valued logic.** A predicate is true or false for a track, never unknown. A
> missing value fails the predicate, and negation flips that. So "not rated 5 stars" includes
> unrated tracks, which is what a listener means.

The SQL compiler wraps every negation in `COALESCE(..., 0)` to enforce it.

### 13.2 The rest of the suite

| Suite | Asserts |
|---|---|
| `unit/filter-compile.test.ts` | Operator semantics, parameterization (no interpolation), set algebra, NULL ordering, rejection of type-invalid operators |
| `unit/entity-model.test.ts` | The §3.4 invariants: tracks with zero media, one track with many media, stats surviving media deletion, cascade on track deletion, CUE ranges as ordinary rows, missing files flagged not deleted, album ids stable across match-key changes, FK and STRICT enforcement |
| `unit/audio-hash.test.ts` | Hash unchanged by ID3v2 growth, ID3v1 addition and rename; FLAC STREAMINFO used when valid and ignored when zero; different audio distinguished |
| `unit/fields.test.ts` | Field id uniqueness and **numeric id stability** — a reused id silently corrupts every library on disk, so the pins are a compatibility lock |
| `unit/format.test.ts` | The format-string grammar, including bracketed-group elision and the renamer pattern end to end |
| `unit/view.test.ts` | Virtualization arithmetic, anchored range selection, filter-stack collapse to an AST, multi-key sort priority |
| `bench/query.bench.ts` | The §12 budgets |

### 13.3 Planned, not yet written

- **Golden-file tag tests** — a corpus of real-world-ugly files (broken ID3 sizes, mixed encodings,
  huge APIC frames, v1/v2 disagreement, Unicode edge cases) with byte-compared write output. This
  becomes the highest-priority suite the moment tag I/O lands, because it is what validates the
  `TagIO` escape hatch in Appendix A.5.
- **Fuzzing** on the tag reader and the smart-string parser — both eat untrusted input.
- **Playback state machine** against a null-sink engine, plus a manual gapless checklist per release.
- **Renderer snapshots** via Playwright. One engine, not three.

## 14. Repository layout

```
anthem/
├── src/
│   ├── main/                 # Electron main process
│   │   ├── db/               # schema, migrations, pragmas, DAO
│   │   │   └── migrations/   # 001-initial.sql — the authoritative schema
│   │   ├── library/          # audio-hash, (planned) scanner, watcher, dedupe
│   │   ├── query/            # compile.ts (AST→SQL), evaluate.ts (AST→predicate)
│   │   ├── tags/             # (planned) TagIO interface + implementation + write journal
│   │   ├── play/             # (planned) PlaybackEngine interface + mpv backend
│   │   ├── services/         # (planned) MPRIS, scrobble, hotkeys, HTTP API
│   │   ├── ipc.ts            # channel handlers, typed by the shared contract
│   │   └── index.ts          # app lifecycle and window
│   ├── preload/              # contextBridge, exposing only declared channels
│   ├── renderer/             # UI — deliberately thin (§2.4)
│   │   ├── widgets/          # Sidebar, SongList, FilterPane, Stars, PlayerBar
│   │   ├── stores/           # thin reactive wrappers over shared/
│   │   ├── layout/           # (planned) layout engine and inspector
│   │   └── theme/
│   ├── shared/               # imported by BOTH sides — the UI-agnostic core
│   │   ├── fields.ts         # field descriptors
│   │   ├── filter.ts         # the filter AST
│   │   ├── format.ts         # the format-string language
│   │   ├── view.ts           # selection, sort, filter stack, virtualization maths
│   │   └── ipc.ts            # the IPC contract
│   └── workers/              # (planned) scan, hash, replaygain
├── test/
│   ├── helpers/              # corpus generator, node:sqlite harness, fast-check arbitraries
│   ├── property/             # the AST-agreement test
│   └── unit/
├── bench/                    # performance budget benchmarks
├── themes/halon/             # tokens.json + generated halon.css
├── scripts/build-theme.mjs   # tokens → CSS custom properties
├── layouts/  fields/  docs/  cli/
├── flake.nix                 # pins node, electron and mpv
└── electron.vite.config.ts
```

## 15. Roadmap

**M0 — Skeleton. ✅ done.** Electron shell, Vite renderer, typed IPC via a shared contract,
Halon tokens → CSS variables, Nix dev shell pinning node/electron/mpv. Went further than planned
because the entity-model decision arrived early: the schema, both query compilers, audio content
hashing, the field descriptor system, the format-string engine, framework-free view state, and a
66-test harness including the AST-agreement property test all landed here. The app launches, migrates
to schema v1 and opens a WAL database.

**M1 — Library core (2 wk).** Scanner, watcher, tag reading, move detection via `audio_hash`, and
the `songlist` widget wired to `shared/view.ts` for real virtualization and column config. Schema,
field descriptors and both query compilers are already done, and §3.5.3 removed the in-memory index
from scope. Milestone test: scan and scroll 50k tracks.

**M2 — Query engine (2 wk).** Filter AST, both compilation targets, the agreement property test,
search bar parser, filter panes, filter stack chips.

**M3 — Playback. ✅ mostly done.** mpv backend over JSON IPC, player with queue vs standing list,
repeat and shuffle, play and skip counting, ReplayGain application, source selection, transport and
seek bar, live queue tab, double-click to play. Still outstanding: MPRIS, global media keys,
crossfade, and verifying gapless against a known-gapless album.

**M3.5 — Song properties. ✅ done.** The view described in §6.5: identity and how it was decided,
every media source with its location and technical detail, raw per-source tags side by side where
they disagree, statistics, and merge provenance. Read-only, so it carries none of the tag editor's
risk, and it is what makes the entity model legible.

**M4 — Ratings and stats (1 wk).** Rating widget, play/skip history recording, stats fields
filterable and sortable, optional tag write-back.

**M5 — Smart playlists (2 wk).** Saved filters, smart playlist editor UI over the AST, limits,
weighted random, auto-fill, playlist import/export.

**M6 — Tag editing (3 wk).** Single and mass edit, dry-run diffs, write journal and undo, tags↔
filename, artwork management, album operations. Includes the Picard hand-off (§7.1.1), which is
small and should land first — it covers authoritative tagging without Anthem writing anything.

Also here: the field editor and column picker that make §3.2.1's promise true for user-defined
fields.

**M7 — Layout system (3 wk).** Layout documents, widget manifests, drag-to-rearrange, layout
inspector, hot reload, `extends` + patches, shipped alternate layouts.

**M8 — Theming and polish (2 wk).** Theme loader, theme editor, density modes, keybinding editor,
accessibility pass (keyboard-complete, focus visible, screen reader labels), tray/notifications.

**M9 — Migration and 1.0 (2 wk).** iTunes/Rhythmbox import, merge history view,
`anthemctl`, packaging (AppImage, Flatpak, `.deb`, Nix flake, MSI, `.dmg`), documentation.

Post-1.0: plugin system, remote web UI, replay-gain scanner UI, lyrics/artist-info providers,
visualizer library, multi-library support.

---

## 16. Decisions taken (and what would reverse them)

| Decision | Reversal trigger |
|---|---|
| **Electron + TypeScript** over Tauri + Rust | Idle RSS or million-track performance becomes binding; then Appendix A.4 Stack A, with `shared/` porting as the main cost |
| **A track is a piece of music, not a file** (§3.4) | None foreseen. This is the decision everything else hangs off. |
| **Audio content hash for file identity; AcoustID as a hint only** (§3.5) | None. AcoustID's many-to-many mapping to recordings rules it out as a key regardless of collision rate. |
| **Two-valued filter logic** (§13.1) | User reports that "not X" excluding unknowns is expected; unlikely |
| **50k target, and no in-memory index** (§3.5.3, §12) | A real library misses a §12 budget. The trigger is a measurement, not a hunch; `evaluate.ts` already exists to be fed by an index. |
| Preact + signals over Svelte and React | A needed React library fails under `preact/compat`, or signals stop keeping the hot paths local. Cheap by construction (§2.4). |
| libmpv default engine | Packaging friction on Windows/macOS → promote a Web Audio or native fallback |
| `node-taglib-sharp` for tags | Golden-file failures it cannot fix → swap the `TagIO` implementation for a mutagen sidecar (Appendix A.5) |
| JSON layouts, not a DSL | Users find JSON hostile → add a friendlier surface *above* JSON, never replace it |
| Stable numeric field ids | Never reversible. Reusing one corrupts every library already on disk. |

## 17. Open questions

1. **Album identity.** Expanded in §17.1 — still the one schema-shaped decision left, though §17.1's
   `pinned` mechanism makes the heuristic tunable after 1.0 rather than frozen.
2. **CUE sheets.** Resolved by the entity model; see §17.2.
3. **Multi-value artist storage.** Split `"A feat. B"` on import, or keep the raw string and split
   only for display and filtering? Proposal: store raw *and* derived, filter on derived — costs
   storage, never destroys a tag. `media_tags` already holds the raw per-source values, so this is
   close to decided.
4. **Stats write-back default.** Off is safer; on makes the library portable and survivable. Since
   statistics now live on the track and a track may have several media, write-back also needs a
   policy for *which* files receive them. Currently specified off.
5. **Conflict policy.** The database is the source of truth, but files change underneath it. When a
   scan finds a tag that disagrees with the database, which wins? Proposal: the database wins for
   fields the user has edited (tracked per field), the file wins otherwise, and the disagreement is
   always visible rather than silently resolved. Needs deciding before M1's scanner.
6. **Video files.** gmusicbrowser tolerates them. Proposal: index and play audio-only, no video
   window, in v1.
7. **Multi-library / profiles.** Deferred, but the database path is already parameterized
   (`ANTHEM_DB`), so it stays possible.

### 17.1 Album identity (expanded)

**The problem.** "Album" is not an entity in a music file — it is a *string* in a tag. Anthem has to
manufacture an entity from it, and every reasonable rule is wrong somewhere:

| Rule | Breaks on |
|---|---|
| `(artist, album)` | **Compilations.** A 20-artist soundtrack becomes 20 one-track albums. This is the single most common album-grouping bug in music players. |
| `(album_artist, album)` | Files with no `album_artist` (very common in older rips) collapse into one giant untitled album, *and* "Greatest Hits" by four different artists merges into one. |
| `(album_artist, album, year)` | A CD rip tagged 1973 and a remaster tagged 2011 split into two albums — sometimes right, sometimes not. |
| folder path | Multi-disc albums stored as `Album/Disc 1`, `Album/Disc 2` split in two. Correct surprisingly often otherwise. |
| `mb_release_id` | Precise and unambiguous — but most local libraries have it on well under half their files. |

**Why it must be settled before M1.** `tracks.album_id` is a foreign key, and real data hangs off the
album row: cover art, album ReplayGain, "date added", album-level user notes, and album-mode shuffle
boundaries. If the identity rule changes in M5, every album row is re-derived and everything attached
to the old rows is orphaned.

**Decision, and the thing that makes it safe.** `albums` is a real table with a stable synthetic
primary key. Identity is *computed* into a `match_key` column, not used *as* the key:

```sql
CREATE TABLE albums (
  id         INTEGER PRIMARY KEY,        -- stable forever, survives rule changes
  match_key  TEXT NOT NULL,              -- derived; recomputed when the rule or tags change
  pinned     INTEGER NOT NULL DEFAULT 0, -- 1 = user merged/split this by hand; never auto-regroup
  name       TEXT, album_artist_id INTEGER, year INTEGER,
  mb_release_id TEXT,
  UNIQUE(match_key)
);
```

`match_key` resolution order:
1. `mb_release_id` if present.
2. `normalize(album_artist_or_artist) + '\x1f' + normalize(album) + '\x1f' + year`, where a track
   whose album has ≥ 3 distinct artists and no `album_artist` is treated as a **compilation** and
   drops the artist component entirely.
3. Folder path as a tie-breaker *only* when the album name is empty or generic
   (`Unknown Album`, `Various`, `CD1`).

`normalize()` casefolds, strips diacritics, collapses whitespace, and removes a configurable
edition-suffix list (`(Remastered)`, `[Deluxe Edition]`, `(2011 Remaster)`) into a separate
`edition` field rather than discarding it.

The `pinned` flag is what de-risks the whole decision: a user merge or split writes `pinned = 1`, and
the rescan never overrides it. That means the heuristic can be **changed after 1.0** without
destroying user intent — which turns an irreversible schema decision into a tunable one.

**Still open:** whether a remaster is the same album as the original by default. Proposal: **no** —
different `year` means different album, with a one-click "merge these" in the album view. Splitting
is a smaller annoyance than silently merging two masterings and computing one album gain across both.

### 17.2 CUE sheets — resolved by the entity model

**Status: no longer an open question.** This was the second schema-freezing decision in the v0.1
draft, and §3.4 dissolved it.

A CUE sheet describes track boundaries inside one audio file — a live album, a DJ mix, a vinyl rip.
The original worry was that `path TEXT NOT NULL UNIQUE` assumed one row per file, and that changing
it later would be invasive across five subsystems at once.

Under the track/media model, a CUE range is simply a `media` row that addresses part of a container:
`uri` plus `subtrack_index`, `start_ms`, `end_ms`, with `UNIQUE(uri, subtrack_index)`. Whole-file
media leave those at their defaults, so the common case pays nothing. `test/unit/entity-model.test.ts`
pins the behaviour today, before any CUE parser exists.

What remains is ordinary feature work, scheduled rather than architectural: a `.cue` parser, reading
FLAC's embedded `CUESHEET` block, and passing start/end to the playback engine. Tag writing needs a
policy — per-subtrack tags cannot go into a shared container, so they live in the database or get
written back into the `.cue`. Mass tagging must refuse or redirect rather than silently writing to
the container.

**The same shape covers** `.m4b` audiobook chapters and Opus chapter metadata, which were never
listed as requirements but come along for free.

Worth noting: neither reference player solves this. gmusicbrowser is partial, and Quod Libet 4.7.1
has no CUE support at all — verified against its source, where the string does not appear.

## 18. Feature parity backlog — gmusicbrowser and Quod Libet

This section is a **decision queue, not a commitment**. Every notable capability of both reference
players is listed so nothing is lost by omission. Each item carries a status:

- **In v1** — already specified in §§3–10 above; listed here for cross-reference.
- **Decide** — genuinely open; needs a yes/no/when before the milestone that would host it.
- **Post-1.0** — wanted, but scheduled after 1.0 unless promoted.
- **Reject** — deliberately not doing it; reason given so it is not re-litigated.

Where the two players solve the same problem differently, the difference is called out — those are
the most interesting decisions in the document.

### 18.1 Browsing and views

| Capability | gmb | QL | Status | Note |
|---|---|---|---|---|
| Flat song list with configurable columns | ✓ | ✓ | **In v1** | §6.1 |
| Grouped/tree song list (album headers) | SongTree | Album List | **In v1** | §6.1 |
| Cascading filter panes | Browser panes | Paned Browser | **In v1** | §6.2 |
| Album grid with cover art | ✓ | Album List | **In v1** | `albumgrid` widget |
| Album *Collection* (albums grouped by artist/genre in a tree) | — | ✓ | **Decide** | QL-only; cheap once `albumgrid` exists |
| Filesystem browser (browse by directory tree) | partial | ✓ | **Decide** | Real value for unscanned/loose files |
| Playlist-as-browser (playlists are a browse mode) | ✓ | ✓ | **In v1** | Sidebar section |
| Saved-search browser (searches listed like playlists) | ✓ | ✓ | **In v1** | §4.3 |
| "Random album" / "choose random" actions | ✓ | — | **Decide** | One line of work; good for radio-mode users |
| Duplicate browser | — | ✓ | **In v1** | §9.2 |
| Missing/invalid files view | ✓ | ✓ | **In v1** | §9.1 |
| Internet radio browser | — | ✓ | **Post-1.0** | Needs a stream engine path and a station DB |
| Podcast / audio feeds | — | ✓ | **Post-1.0** | Large surface: subscriptions, downloads, resume, unplayed state |
| Soundcloud browser | — | ✓ | **Reject** | Third-party API that keeps breaking; not local-library work |
| Cover-art-only "wall" fullscreen mode | ✓ | ✓ | **Decide** | Fullscreen layout, not a separate feature, once §5 exists |
| Column presets / quick column sets | ✓ | ✓ | **Decide** | Layout `extends` may cover this already |
| Sticky/pinned filter presets on a toolbar | ✓ | — | **Decide** | gmb's FilterBox widget |

### 18.2 Query, filtering, playlists

| Capability | gmb | QL | Status | Note |
|---|---|---|---|---|
| Full filter algebra over every field | ✓ | ✓ | **In v1** | §4.1 |
| Text query language in a single box | smart strings | `#(rating > 3)` syntax | **In v1** | §4.4 — Anthem's own syntax, both importable |
| Regex matching on any field | ✓ | ✓ (Python `re`) | **In v1** | `regex` op; Rust `regex` crate, no backrefs |
| Numeric comparison with units (`#(length > 4:00)`) | ✓ | ✓ | **In v1** | Duration/date literals in the parser |
| Relative-date queries (`#(lastplayed < 7 days)`) | ✓ | ✓ | **In v1** | `in_last` |
| Top-N / bottom-N by field | ✓ | — | **In v1** | `top` / `bottom` |
| Saved filters composable inside other filters | ✓ | ✓ | **In v1** | `in_filter`, cycle-checked |
| Smart playlist limits (count / duration / size) | ✓ | ✓ | **In v1** | §4.3 |
| Weighted random by rating/play count | ✓ | ✓ | **In v1** | §4.3 |
| Static playlists with manual ordering | ✓ | ✓ | **In v1** | |
| Playlist folders / nesting | — | — | **Decide** | Neither has it; large libraries want it |
| Query "shortcuts"/aliases (`@shortcut`) | — | ✓ | **Decide** | Nice ergonomics; trivial atop `in_filter` |
| Per-pane multi-select semantics (OR within, AND across) | ✓ | ✓ | **In v1** | §6.2 |
| Filter history / back-forward through views | ✓ | — | **Decide** | gmb's HistItem; genuinely useful, small |
| Playlist import/export (M3U/PLS/XSPF) | ✓ | ✓ | **In v1** | §9.3 |
| CUE sheet support (virtual tracks from one file) | partial | ✗ | **Decide** | Neither reference player does this properly (QL 4.7.1 has no CUE code at all). Affects the track identity model — reserve schema at M1, §17.1 |

### 18.3 Tagging and library

| Capability | gmb | QL | Status | Note |
|---|---|---|---|---|
| Mass tag editing with `<multiple>` handling | ✓ | ✓ | **In v1** | §7.2 |
| Tags-from-filename with pattern preview | ✓ | ✓ | **In v1** | §7.2 |
| Filename-from-tags / organize files | ✓ | ✓ | **In v1** | §7.2 |
| Find & replace across a field, regex | ✓ | ✓ | **In v1** | §7.2 |
| Title-case / case transforms with exceptions | ✓ | ✓ | **In v1** | §7.2 |
| Split/merge multi-value tags | ✓ | ✓ | **In v1** | §7.2 |
| Standalone tag editor app | — | ✓ (Ex Falso) | **Decide** | Anthem could ship the tag editor as a separate window/binary |
| Arbitrary user-defined fields | ✓ | ✓ | **In v1** | §3.1 |
| Free-form labels/tags on tracks | ✓ | ✓ (`~grouping`) | **In v1** | `tags` set field |
| Preserve unknown tag frames | ✓ | ✓ | **In v1** | §7.1 — hard requirement |
| Undo for tag writes | — | — | **In v1** | §7.1; neither reference player has this and both should |
| Embedded artwork read/write, multiple image types | ✓ | ✓ | **In v1** | §7.3 |
| External cover art discovery by filename pattern | ✓ | ✓ | **In v1** | §7.3 |
| Cover art fetching from the web | ✓ (plugin) | ✓ (plugin) | **Post-1.0** | Plugin, §11 |
| Lyrics: embedded read/write | ✓ | ✓ | **In v1** | `lyrics` field |
| Lyrics: web fetch + local `.lrc` files | ✓ | ✓ | **Post-1.0** | Synced-lyrics display is its own widget |
| Karaoke / synced lyric highlight | ✓ | — | **Post-1.0** | Depends on `.lrc` support |
| Artist info / album info panels (Wikipedia, allmusic) | ✓ | ✓ | **Post-1.0** | Plugin; `contextpanel` widget hosts it |
| Web context panel (arbitrary URL templated on now-playing) | ✓ | ✓ | **Post-1.0** | Cheap and surprisingly useful |
| MusicBrainz lookup / tag from MB | — | ✓ (plugin) | **Post-1.0** | Not competing with Picard, but a per-album lookup is reasonable |
| AcoustID / fingerprinting | — | ✓ (plugin) | **Decide** | Only worth it if dedupe demands it |
| CD ripping | ✓ (plugin) | — | **Reject** | Solved better by dedicated tools |
| Library statistics / "song info" summary | ✓ | ✓ | **Decide** | Aggregate view: totals, top artists, listening over time |
| Import ratings/playcounts from other players | ✓ | ✓ (plugins) | **In v1** | §9.3 |
| Export library to CSV/JSON/HTML | ✓ | ✓ | **In v1** | §9.3 |
| Auto library update on file change | ✓ | ✓ | **In v1** | §9.1 |
| Moved-file detection preserving stats | partial | partial | **In v1** | §9.1 |
| Multiple libraries / profiles | — | — | **Post-1.0** | §17.5 |
| Trash/delete files from within the app | ✓ | ✓ | **Decide** | Needs a confirmation model; easy to regret |

### 18.4 Playback

| Capability | gmb | QL | Status | Note |
|---|---|---|---|---|
| Gapless playback | ✓ | ✓ | **In v1** | §8.2 |
| Crossfade | ✓ | ✓ | **In v1** | §8.2 |
| ReplayGain apply (track/album, preamp, limiter) | ✓ | ✓ | **In v1** | §8.2 |
| ReplayGain/R128 scanning built in | — | ✓ (plugin) | **In v1** | §8.2 background job |
| Queue separate from playlist | ✓ | ✓ | **In v1** | §8.2 |
| Queue modes (ignore/keep/exclusive) | partial | ✓ | **Decide** | QL's "queue disables shuffle" nuances are worth copying |
| Auto-fill queue from a filter when it empties | ✓ | — | **In v1** | §8.2 — a signature gmb feature |
| Lock to artist/album/filter | ✓ | — | **In v1** | §8.2 |
| Repeat all / one / album | ✓ | ✓ | **In v1** | |
| Shuffle by track / by album | ✓ | ✓ | **In v1** | |
| Weighted/smart shuffle | ✓ | ✓ | **In v1** | §4.3 |
| Equalizer | ✓ | ✓ | **In v1** | §8.2 |
| Playback speed / pitch | — | ✓ | **In v1** | §8.2 |
| Sleep timer / fade-to-sleep ("lullaby") | ✓ (plugin) | ✓ (plugin) | **Decide** | Small, well-loved |
| Bookmarks within a track | ✓ | ✓ | **In v1** | §8.2 |
| Resume playback position on launch | ✓ | ✓ | **In v1** | §8.2 |
| Stop after current track | ✓ | ✓ | **Decide** | Trivial; just needs a home in the UI |
| Waveform seekbar | — | ✓ (plugin) | **Post-1.0** | Requires a background analysis pass + cache |
| Visualizer | ✓ | — | **Post-1.0** | Web Audio makes this the easiest win Anthem has |
| Output device selection | ✓ | ✓ | **In v1** | Delegated to mpv |
| Streaming out (Icecast/DLNA server) | ✓ (iceserver) | — | **Reject** | Out of scope; a separate daemon's job |
| Play remote/streaming URLs ad hoc | ✓ | ✓ | **Decide** | Cheap via mpv; the *library* side is what's expensive |

### 18.5 UI, layout, theming

| Capability | gmb | QL | Status | Note |
|---|---|---|---|---|
| Fully user-composed window layout | ✓ (`.layout`) | — | **In v1** | §5 — Anthem's headline feature |
| Multiple shipped layouts, switchable at runtime | ✓ | — | **In v1** | §5.3 |
| Detached/floating panel windows | ✓ | — | **Decide** | Multi-window in a WebView shell is real work |
| Desktop widget mode (borderless always-on-top) | ✓ (plugin) | — | **Decide** | Falls out of layouts + a window-mode flag |
| Fullscreen "now playing" mode | ✓ | ✓ | **In v1** | A shipped layout |
| Mini/compact player mode | ✓ | ✓ | **In v1** | A shipped layout |
| Tray icon with menu and scroll-volume | ✓ | ✓ | **In v1** | §10 |
| Title-bar / taskbar now-playing text | ✓ (plugin) | ✓ | **In v1** | Format strings, §5.5 |
| Desktop notifications with art | ✓ | ✓ | **In v1** | §10 |
| Configurable context menus | ✓ | ✓ | **In v1** | §6.1 |
| Rebindable keyboard shortcuts | partial | ✓ | **In v1** | §10 |
| Global media keys | ✓ | ✓ | **In v1** | §10 |
| Theming beyond the toolkit theme | limited | limited | **In v1** | §5.4 — the other headline feature |
| Density / compact modes | — | ✓ | **In v1** | §5.4, from Halon's density scale |
| Icon theme override | ✓ | ✓ | **Decide** | Ship one icon set; allow replacement via theme dir |
| Localization / translations | ✓ (30+) | ✓ | **Post-1.0** | String extraction from day one, translation after 1.0 |
| Accessibility: full keyboard + screen reader | weak | weak | **In v1** | §M8 — both references are poor here; not an excuse |

### 18.6 Integration and automation

| Capability | gmb | QL | Status | Note |
|---|---|---|---|---|
| MPRIS2 | ✓ | ✓ | **In v1** | §10 |
| Last.fm scrobbling | ✓ | ✓ | **In v1** | §10 |
| ListenBrainz | — | ✓ | **In v1** | §10 |
| Command-line control | ✓ | ✓ (`quodlibet --next`) | **In v1** | `anthemctl`, §10 |
| Named-pipe/FIFO control | ✓ | — | **Reject** | Superseded by the HTTP API + CLI |
| HTTP remote control / web UI | — | ✓ (plugin) | **In v1** (API) / **Post-1.0** (web UI) | §10 |
| "Run a command on track change" hooks | ✓ | ✓ | **Decide** | Powerful and a security surface; needs an explicit opt-in model |
| Custom user commands on selection (`%f`, `%s`) | ✓ | ✓ | **Decide** | Same decision as above |
| Squeezebox / MQTT / external device sync | — | ✓ (plugins) | **Reject** | Plugin territory if anyone wants it |
| Portable-device sync (MTP/iPod) | — | ✓ (plugin) | **Post-1.0** | Plugin, §11 |
| Plugin system | ✓ (Perl) | ✓ (Python, ~100 plugins) | **Post-1.0** | §11 |
| Autosave / crash-safe library persistence | ✓ (plugin) | ✓ | **In v1** | SQLite WAL makes this structural, not a plugin |

### 18.7 Things neither has that Anthem should decide on

| Idea | Status | Note |
|---|---|---|
| Tag-write undo journal | **In v1** | §7.1 |
| Content-hash move detection | **In v1** | §9.1 |
| Filter AST as a first-class shareable artifact | **In v1** | §4.1 |
| Listening-history analytics (year in review, trends) | **Decide** | The data is already there; the UI is the cost |
| Multi-device library sync (stats only, CRDT) | **Post-1.0** | Big, but the play/skip history model is already append-only |
| Rating propagation rules (rate an album → rate its tracks) | **Decide** | Small, opinionated, easy to get wrong |
| Library health report (missing art, no genre, bad encodings) | **Decide** | A set of shipped smart filters may be enough |

### 18.8 How these get decided

Every **Decide** row must be resolved before the milestone that would host it: browsing/query items
before M2, tagging before M6, playback before M3, UI/layout before M7, integration before M9.
Resolution means moving the row to **In v1**, **Post-1.0**, or **Reject** with a one-line reason —
this table is the record, and it gets edited in place rather than appended to.


---

## Appendix A — Language and stack evaluation

The v0.1 draft picked Rust without arguing the alternative. This appendix does the comparison
properly, because "ease of development" is a legitimate first-order requirement, not a compromise.

> **Outcome: Stack B was chosen and is implemented.** §2 is now written in terms of it, and this
> appendix is kept as the reasoning record and as the reversal plan if §16's triggers fire.

### A.1 How much of this spec actually depends on the language?

Very little. Sections 3 (data model), 4 (query engine), 5 (layout and theming), 6 (interaction),
7 (tag semantics), 9 (library management), 10 (integrations), 11 (plugins), 13 (testing) and 18
(parity backlog) are **stack-independent** — they describe schemas, grammars, formats and behaviour.
Only §2 (architecture), §12 (performance budget) and §14 (repo layout) change.

That is the important framing: choosing wrong here costs a rewrite of the *plumbing*, not of the
design.

### A.2 Where the requirements actually put pressure

| Requirement | Language-sensitive? | Notes |
|---|---|---|
| Gapless playback, format coverage, ReplayGain | **No** | mpv does it. Every language talks to mpv over a JSON IPC socket. A complete wash. |
| SQLite library, FTS5 search | **No** | `better-sqlite3` (synchronous, C++), Python `sqlite3`, and `rusqlite` are all fast enough. |
| 250k-row filter / group-by at interactive speed | **Somewhat** | Rust wins, but SQLite indexes carry most of it. JS TypedArrays + `roaring-wasm` gets ~80% of the Rust plan; Python needs numpy to compete. |
| Scanning 100k files | **Somewhat** | Rust ≈ 3–5× faster. This is background work that happens once — a 4-minute scan becoming 12 minutes is annoying, not disqualifying. |
| **Lossless tag read/write, unknown-frame preservation** | **Yes — the real pressure point** | See A.3. |
| Virtualized 60 fps list | **No** | Renderer-side in all three; identical code. |
| Packaging and install size | **Yes** | Rust/Tauri ≪ Electron ≪ Python. |
| Development velocity | **Yes, inverted** | TypeScript ≫ Python > Rust for this app's shape. |

### A.3 The tag library is the deciding factor

§7.1 makes a hard promise: *"Anthem is not allowed to lose a tag it does not understand."* That
promise is only as good as the library behind it.

| Library | Language | Assessment |
|---|---|---|
| **mutagen** | Python | The gold standard. Powers Quod Libet and MusicBrainz Picard. Two decades of real-world ugly-file hardening. Nothing else is close. |
| **lofty-rs** | Rust | Good, modern, actively maintained, broad format coverage. Younger, less battle-scarred. |
| **node-taglib-sharp** | TypeScript | A real port of the mature taglib-sharp, and it *writes*. Less proven than either of the above. |
| **music-metadata** | TypeScript | Excellent reader — but **read-only**. Disqualifying on its own. |

This is the one place where Python has a decisive technical advantage over both alternatives.

### A.4 The three candidate stacks

**Stack A — Rust core + web UI (the v0.1 draft).**
Tauri 2 · Rust · rusqlite · lofty · libmpv · Svelte.
*Best at:* raw performance headroom, 40 MB installs, ~200 MB RSS, million-track libraries, and a
compiler that makes the field-descriptor and filter-AST systems genuinely hard to get wrong.
*Costs:* slowest to write, by a lot. Three WebView engines (§6.4) means real CSS divergence work.
Every UI iteration crosses a compile boundary.

**Stack B — TypeScript end to end. ← recommended**
Electron · TypeScript · better-sqlite3 · node-taglib-sharp · mpv over JSON IPC · Preact.
*Best at:* velocity. One language, one type system, one build, shared types across the IPC boundary
with zero codegen. Instant reload on both sides. One rendering engine, so §6.4's CSS restrictions
evaporate — `:has()`, container queries and subgrid all become available, which measurably helps a
layout-heavy app. The largest ecosystem for virtualization, drag-and-drop and editors.
*Costs:* ~150 MB install, ~350–500 MB RSS for an always-running app. The tag library is the least
proven of the three. Main-thread blocking is a real hazard and must be designed against (A.6).

Note the forced link: **choosing TypeScript means choosing Electron, not Tauri.** Tauri's backend
*is* Rust — pairing it with TypeScript means shipping a Node sidecar alongside a Rust shell, which
is the worst of both worlds.

**Stack C — Python core + web UI.**
pywebview or Electron shell · Python · mutagen · python-mpv · FastAPI-style local IPC.
*Best at:* mutagen, unambiguously. Fast to write for scan/tag logic.
*Costs:* desktop packaging is the worst of the three by a wide margin (PyInstaller/Briefcase, or
requiring a system Python). The GIL makes the in-memory index awkward without numpy. And the UI is
TypeScript regardless — so you get two languages anyway, without Rust's compensating benefits.

### A.5 Recommendation

**Stack B**, with one deliberate escape hatch.

The reasoning: mpv neutralizes the playback argument entirely, SQLite neutralizes most of the query
argument, and scanning speed is background work. That strips Rust's advantage down to *memory
footprint* and *headroom above 250k tracks* — real, but not worth a 2–3× slowdown in every UI
iteration on a project whose headline features (§5 layout, §5.4 theming) are **both** UI work.

The escape hatch, mirroring the `PlaybackEngine` trait: **all tag I/O sits behind a `TagIO`
interface** with exactly four methods (`read`, `write`, `readArtwork`, `writeArtwork`). The default
implementation is node-taglib-sharp. The golden-file suite in §13 is what validates it — and if it
fails a class of real-world files it cannot fix, swap in a **mutagen sidecar** (a ~200-line Python
process speaking JSON over stdio) without touching a single line of the rest of the app.

That structure means the riskiest part of Stack B is also its most isolated part, and the decision is
testable in M1 rather than being a bet made now.

**Pick Stack A instead if** any of these become true: libraries beyond ~1M tracks are a target,
polished cross-platform distribution matters more than iteration speed, or idle RSS above 300 MB is
unacceptable.

### A.6 What changes in the spec under Stack B

**§2.1 / §2.2 — Architecture.** Electron with three processes: main (library, query, tag, playback
supervision), a `worker_threads` pool (scanning, hashing, index building — this is mandatory, not
optional, because a blocked main thread stalls audio *control* and the UI simultaneously), and the
renderer. IPC via `contextBridge` with a shared TypeScript type module — no codegen step.

**§3.5 — In-memory index.** `Int32Array`/`Float64Array` columns instead of `Vec<T>`; `roaring-wasm`
instead of the `roaring` crate; a `Map<string, number>` symbol table with precomputed
`Intl.Collator` sort keys. Built inside a worker and transferred as `SharedArrayBuffer`, so the
main thread never blocks on it.

**§8.1 — Playback.** mpv over its JSON IPC socket, still behind the `PlaybackEngine` interface. The
symphonia fallback is replaced by "Web Audio in the renderer" as the dependency-free path — weaker on
format coverage, fine as a fallback.

**§12 — Performance budget, relaxed and re-baselined:**

| Operation | Stack A | Stack B |
|---|---|---|
| Cold start → interactive (250k) | 3 s | 4 s |
| In-memory index load | 1.5 s | 2.5 s |
| Filter (any AST) | 100 ms | 150 ms |
| Sort by any column | 150 ms | 250 ms |
| Group-by for a filter pane | 80 ms | 120 ms |
| Search keystroke → results | 50 ms | 60 ms |
| Scroll frame | 16 ms | 16 ms (unchanged) |
| Full scan, 100k files | 4 min | 10 min |
| Idle RSS (playing, 250k) | < 400 MB | < 600 MB |
| Install size | ~40 MB | ~150 MB |

**§14 — Repository layout:**

```
anthem/
├── src/
│   ├── main/            # Electron main: library, query, tags, playback, services
│   │   ├── library/     # index, scanner, watcher, dedupe
│   │   ├── query/       # filter AST, SQL compiler, native predicate, search parser
│   │   ├── tags/        # TagIO interface + taglib-sharp impl + write journal
│   │   ├── play/        # PlaybackEngine interface + mpv impl
│   │   └── services/    # MPRIS, scrobble, hotkeys, HTTP API
│   ├── workers/         # scan, hash, index-build, replaygain
│   ├── shared/          # types, field descriptors, format strings, filter AST — imported by BOTH sides
│   └── renderer/        # layout engine, widgets, theme runtime, stores
├── fields/  layouts/  themes/  docs/  bench/
└── cli/                 # anthemctl
```

The `shared/` directory is Stack B's main structural payoff: the filter AST, field descriptors and
format-string parser are written **once** and used by the query engine and the UI editor that builds
queries — in Stack A that is either duplicated or code-generated.

**§13 — Testing.** `fast-check` replaces `proptest` for the AST-agreement property test. Golden-file
tag tests become the highest-priority suite in the repo, since they are what validates the A.5
escape hatch. Playwright covers one engine instead of three.

**§16 — Decisions table** records this, with its reversal triggers.

### A.7 What the implementation confirmed

Building the skeleton tested three of this appendix's claims:

- **The `shared/` payoff is real and larger than argued.** The filter AST is imported by the SQL
  compiler, the native predicate, the IPC contract and the UI that builds queries — one definition,
  no codegen, and a type error at any misuse. A.1 called this the main structural benefit; it is.
- **The native-module concern was overstated for tests.** Node's built-in `node:sqlite` runs the
  real SQL without `better-sqlite3`, so the test suite is free of ABI juggling entirely. Only the app
  needs the Electron-ABI build, and `better-sqlite3` loaded under Electron without incident.
- **The tag-library risk (A.3) is untested**, because tag I/O is not written yet. It remains the one
  place where Stack B is weakest, and the `TagIO` interface plus golden-file suite is still how that
  gets settled rather than assumed.
