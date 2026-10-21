# X-Music

[![AI readiness](https://img.shields.io/endpoint?url=https://x-tech-laboratories.github.io/badges/x-tech-laboratories/X-Music.json)](https://x-tech-laboratories.github.io/guidelines/readiness/)

A desktop music player with gmusicbrowser's data model and power, a web-technology UI that users can
re-layout and re-skin, and [Halon](https://github.com/BeatLink/Halon) as its reference theme.

The design is specified in full in [DESIGN-SPEC.md](docs/DESIGN-SPEC.md). This README covers only how to
run what exists.

## Status

Early. The library core, query engine and testing harness are real; playback and tag I/O are not
implemented yet. See the roadmap in DESIGN-SPEC §15.

| Area | State |
|---|---|
| SQLite schema, migrations, entity model | working |
| Identity resolution (idempotent import and scan) | working |
| Filesystem scanner (read-only, move detection) | working |
| gmusicbrowser import | working |
| Filter AST → SQL and → native predicate | working, agreement property-tested |
| Audio content hashing (move/rename detection) | working |
| Field descriptor system | working |
| Format-string engine | working |
| Framework-free view state (selection, sort, virtualization) | working |
| Halon theming | working |
| Renderer shell | placeholder widgets |
| Playback (mpv, queue, repeat/shuffle, play counting) | working |
| MPRIS, media keys, crossfade | not started |
| Tag writing | not started (read-only by default) |
| Filesystem watching | not started |
| Merge tracks, with per-field resolution and undo | working |
| Duplicate detection (hash, MBID, tags, fuzzy) | working |
| Song properties (identity, sources, raw tags, history) | working |
| Album art (embedded, folder image, cached) | working |
| Picard hand-off for tagging | specified (DESIGN-SPEC §7.1.1) |

## The one idea worth knowing

**A track is a piece of music, not a file.** It survives renames, moves, format changes, retagging,
and having no file at all. Anything that can render it — a local file, a second copy in another
format, a CUE range inside a larger file, a streaming URI — is a `media` row hanging off it.

Files are identified by an **audio content hash** computed over the audio stream with metadata
excluded, so retagging never changes a file's identity and a moved file is still recognisably the
same file. AcoustID answers a different question (*is this the same recording?*) and is a hint on
the track, never a key.

## Development

The Nix flake pins everything, including the Electron the native module is built against.

```sh
nix develop
npm install
npm run dev
```

The shell hook clears `ELECTRON_RUN_AS_NODE`, which VSCode's integrated terminal exports and which
otherwise makes Electron run as bare node and die on the ESM entry point.

### Commands

| Command | Does |
|---|---|
| `npm run dev` | Run with hot reload |
| `npm run build` | Typecheck and build to `out/` |
| `npm test` | Full suite |
| `npm run test:watch` | Watch mode |
| `npm run bench` | Performance budget benchmarks |
| `npm run typecheck` | `tsc` for main/preload and for the renderer |
| `npm run theme` | Regenerate `themes/halon/halon.css` from `tokens.json` |
| `npm run app` | Build if needed and launch, read-only |
| `npm run rebuild:electron` | Rebuild `better-sqlite3` against Electron's ABI |

Benchmarks default to 50k synthetic tracks (the §12 target); `X_MUSIC_BENCH_SIZE=20000 npm run bench`
for a quicker pass. Point the app at a scratch database with `X_MUSIC_DB=/tmp/x-music.db`.

### Logging

Configured entirely by environment, so detail can be turned on without a rebuild.

```sh
X_MUSIC_LOG=debug npm run app              # everything
X_MUSIC_LOG=warn,play:debug npm run app    # quiet, except playback
X_MUSIC_LOG_FILE=/tmp/x-music.log npm run app
```

Levels are `critical`, `error`, `warn`, `info` (default) and `debug`; `warning`, `err`, `verbose`
and `trace` are accepted as aliases. A scope can be raised or lowered on its own with
`scope:level`, and `*:level` sets the default. Scopes in use: `app`, `play`, and `ui:*` for anything
originating in the renderer.

**Renderer records go to the same stream**, forwarded to the main process, so a UI failure is
visible from the terminal rather than trapped in a devtools console nobody has open. Uncaught errors
and unhandled rejections are reported automatically.

A malformed `X_MUSIC_LOG` falls back to the default rather than silencing logging.

### Read-only by default

X-Music starts read-only and `npm run app` pins it with `X_MUSIC_FORCE_READ_ONLY=1`. Every
filesystem-mutating operation goes through `assertWritable()` in `src/main/safety.ts`, which throws
unless the path is inside X-Music's own data directory. Point it at a real music library safely.

### Getting your library in

Settings → Import reads a gmusicbrowser `gmbrc`, defaulting to the standard location for your
platform. It imports ratings, play counts, skip counts, full play history, genres, groupings,
labels and saved lists. A preview parses the file without writing anything, so you see the counts
first.

Settings → Folders adds music directories and scans them. Scanning reads tags only; it never
overwrites X-Music's own ratings or play counts, recognises moved and renamed files by audio content,
and flags files that have disappeared rather than deleting their tracks.

Both are idempotent. Running either twice, or both in either order, will not duplicate anything.

## Testing

The suite is described in DESIGN-SPEC §13. The load-bearing one:

**`test/property/ast-agreement.test.ts`** asserts that for any generated filter over any generated
library, the SQL compiler and the native predicate return identical id sets. The fast path exists
only because this test keeps it honest — it has already caught a three-valued-logic divergence where
SQL silently dropped tracks with a NULL value from negated filters.

Tests reach SQLite through Node's built-in `node:sqlite` rather than `better-sqlite3`, so the suite
never depends on which ABI the native module was last rebuilt for.

## Layout

```
src/
├── main/        Electron main: db, query engine, library, (later) tags, playback, services
├── preload/     The typed IPC bridge, exposing only the declared contract
├── renderer/    UI. Deliberately thin — see below.
├── shared/      Imported by BOTH sides: field descriptors, filter AST, format strings, view state
└── workers/     (planned) scan, hash, index-build, replaygain
```

`shared/` is where the leverage is. The filter AST, field descriptors, format-string engine and view
state (selection, sort, filter stack, virtualization maths) are plain TypeScript with no framework
primitives and no DOM access. Replacing the UI framework touches `renderer/` only.

## Contributing

X-Music is an [X-Tech Laboratories](https://x-tech-laboratories.github.io) project, and AI-assisted
contributions are welcome. Read [AGENTS.md](AGENTS.md) and the
[AI policy](https://github.com/x-tech-laboratories/.github/blob/main/AI_POLICY.md), and say in your
pull request how AI was involved.

## Licence

X-Music is free software, licensed under the [GNU General Public License](LICENSE), version 3 or (at
your option) any later version.
