-- X-Music initial schema.
--
-- The central idea: a `track` is a logical piece of music, not a file. It survives renames, moves,
-- format changes, retagging, and having no file at all. Anything that can actually render it — a
-- local file, a second copy in another format, a CUE range inside a larger file, a streaming
-- provider URI — is a `media` row hanging off it. A track with zero media is still a track.

-- ── identity and provenance ─────────────────────────────────────────────────

CREATE TABLE tracks (
  id                INTEGER PRIMARY KEY,

  -- Canonical metadata. Resolved from media tags, but the database wins on conflict.
  title             TEXT,
  album_id          INTEGER REFERENCES albums(id) ON DELETE SET NULL,
  year              INTEGER,
  track_number      INTEGER,
  disc_number       INTEGER,
  length_ms         INTEGER,
  compilation       INTEGER NOT NULL DEFAULT 0,
  bpm               INTEGER,

  -- Semantic identity, in descending order of trust. None of these is the primary key.
  mb_recording_id   TEXT,
  acoustid          TEXT,
  identity_source   TEXT NOT NULL DEFAULT 'heuristic',
                    -- 'manual' | 'mbid' | 'acoustid' | 'audio_hash' | 'heuristic'
  identity_key      TEXT,
                    -- derived match key; recomputed when the rule or the metadata changes
  pinned            INTEGER NOT NULL DEFAULT 0,
                    -- 1 = a human merged/split this; automated passes must never override it

  -- Statistics are X-Music's, never guessed from tags, and belong to the track, not the file.
  rating            INTEGER,          -- 0..100; NULL means unrated, which is not 0
  play_count        INTEGER NOT NULL DEFAULT 0,
  skip_count        INTEGER NOT NULL DEFAULT 0,
  first_played      INTEGER,
  last_played       INTEGER,
  last_skipped      INTEGER,
  bookmark_ms       INTEGER,
  loved             INTEGER NOT NULL DEFAULT 0,

  rg_track_gain     REAL,
  rg_album_gain     REAL,

  added             INTEGER NOT NULL,
  modified          INTEGER NOT NULL,

  -- Preferred source for playback; NULL means "pick the best available at play time".
  primary_media_id  INTEGER REFERENCES media(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX tracks_album       ON tracks(album_id);
CREATE INDEX tracks_identity    ON tracks(identity_key);
CREATE INDEX tracks_mbid        ON tracks(mb_recording_id) WHERE mb_recording_id IS NOT NULL;
CREATE INDEX tracks_acoustid    ON tracks(acoustid) WHERE acoustid IS NOT NULL;
CREATE INDEX tracks_rating      ON tracks(rating);
CREATE INDEX tracks_last_played ON tracks(last_played);
CREATE INDEX tracks_added       ON tracks(added);

-- ── media: the things that can actually be played ───────────────────────────

CREATE TABLE media (
  id              INTEGER PRIMARY KEY,
  track_id        INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,

  kind            TEXT NOT NULL,      -- 'file' | 'stream'
  uri             TEXT NOT NULL,      -- absolute path for files, provider URI for streams
  provider        TEXT,               -- NULL for local files; 'subsonic', 'jellyfin', ...

  -- A CUE range or a chapter is a media row that addresses part of a container. Whole-file media
  -- leave these NULL / 0, so the common case pays nothing for the capability.
  subtrack_index  INTEGER NOT NULL DEFAULT 0,
  start_ms        INTEGER,
  end_ms          INTEGER,

  -- Identity of the FILE, distinct from identity of the music. Computed over the decoded audio
  -- stream with metadata excluded, so retagging never changes it and a move is detectable.
  audio_hash      BLOB,
  audio_hash_algo TEXT,               -- 'flac-streaminfo-md5' | 'blake3-pcm' | 'blake3-frames'

  codec           TEXT,
  container       TEXT,
  bitrate         INTEGER,
  bitrate_mode    TEXT,               -- 'cbr' | 'vbr' | 'abr' | NULL
  samplerate      INTEGER,
  channels        INTEGER,
  bits_per_sample INTEGER,
  filesize        INTEGER,
  mtime           INTEGER,

  present         INTEGER NOT NULL DEFAULT 1,   -- 0 = known but currently unreachable
  last_seen       INTEGER,
  quality_rank    INTEGER NOT NULL DEFAULT 0,   -- derived; higher wins when auto-selecting
  added           INTEGER NOT NULL,

  UNIQUE(uri, subtrack_index)
) STRICT;

CREATE INDEX media_track   ON media(track_id);
CREATE INDEX media_hash    ON media(audio_hash) WHERE audio_hash IS NOT NULL;
CREATE INDEX media_present ON media(present, kind);
CREATE INDEX media_uri     ON media(uri);

-- Raw tags exactly as read from each media source. Kept per-source so that two files backing one
-- track can disagree without the disagreement being silently lost, and so tag writes can be diffed
-- against what is actually on disk.
CREATE TABLE media_tags (
  media_id  INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  field_id  INTEGER NOT NULL,
  ordinal   INTEGER NOT NULL DEFAULT 0,
  value     TEXT,
  PRIMARY KEY (media_id, field_id, ordinal)
) WITHOUT ROWID;

-- ── albums ──────────────────────────────────────────────────────────────────

CREATE TABLE albums (
  id               INTEGER PRIMARY KEY,
  match_key        TEXT NOT NULL UNIQUE,   -- derived; the id above is what actually persists
  pinned           INTEGER NOT NULL DEFAULT 0,
  name             TEXT,
  edition          TEXT,                   -- '(Remastered)' and friends, split out of the name
  album_artist_id  INTEGER REFERENCES values_(id) ON DELETE SET NULL,
  year             INTEGER,
  disc_total       INTEGER,
  mb_release_id    TEXT,
  mb_release_group_id TEXT,
  is_compilation   INTEGER NOT NULL DEFAULT 0,
  rg_album_gain    REAL,
  added            INTEGER NOT NULL
) STRICT;

CREATE INDEX albums_artist ON albums(album_artist_id);
CREATE INDEX albums_mbid   ON albums(mb_release_id) WHERE mb_release_id IS NOT NULL;

-- ── multi-value fields ──────────────────────────────────────────────────────

-- Interned values for every set-typed field. Grouping 250k tracks by genre becomes a join over
-- small integers rather than a scan over strings.
CREATE TABLE values_ (
  id        INTEGER PRIMARY KEY,
  field_id  INTEGER NOT NULL,
  value     TEXT NOT NULL,
  sort_key  TEXT,
  colour    TEXT,
  mb_id     TEXT,
  UNIQUE(field_id, value)
) STRICT;

CREATE TABLE track_values (
  track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  field_id  INTEGER NOT NULL,
  value_id  INTEGER NOT NULL REFERENCES values_(id) ON DELETE CASCADE,
  ordinal   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (track_id, field_id, ordinal)
) WITHOUT ROWID;

CREATE INDEX track_values_lookup ON track_values(field_id, value_id, track_id);

-- User-defined and long-form fields, so adding a field never means ALTER TABLE on a huge table.
CREATE TABLE track_extras (
  track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  field_id  INTEGER NOT NULL,
  value     TEXT,
  PRIMARY KEY (track_id, field_id)
) WITHOUT ROWID;

-- ── search ──────────────────────────────────────────────────────────────────

CREATE VIRTUAL TABLE tracks_fts USING fts5(
  title, artist, album, album_artist, genre, comment, lyrics,
  content='', tokenize="unicode61 remove_diacritics 2"
);

-- ── history ─────────────────────────────────────────────────────────────────

CREATE TABLE play_history (
  id          INTEGER PRIMARY KEY,
  track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  media_id    INTEGER REFERENCES media(id) ON DELETE SET NULL,
  at          INTEGER NOT NULL,
  kind        INTEGER NOT NULL,     -- 0 = play, 1 = skip
  position_ms INTEGER
) STRICT;

CREATE INDEX play_history_track ON play_history(track_id, at);
CREATE INDEX play_history_at    ON play_history(at);

-- Every tag write, with its prior value, so a mass edit stays undoable.
CREATE TABLE tag_writes (
  id         INTEGER PRIMARY KEY,
  batch_id   INTEGER NOT NULL,
  media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  field_id   INTEGER NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  at         INTEGER NOT NULL,
  applied    INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX tag_writes_batch ON tag_writes(batch_id);

-- ── playlists and saved filters ─────────────────────────────────────────────

CREATE TABLE playlists (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,        -- 'static' | 'smart'
  definition TEXT,                 -- filter AST as JSON, for smart playlists
  parent_id  INTEGER REFERENCES playlists(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  created    INTEGER NOT NULL,
  modified   INTEGER NOT NULL
) STRICT;

CREATE TABLE playlist_tracks (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, position)
) WITHOUT ROWID;

-- ── library roots ───────────────────────────────────────────────────────────

CREATE TABLE roots (
  id       INTEGER PRIMARY KEY,
  path     TEXT NOT NULL UNIQUE,
  include  TEXT,                          -- newline-separated globs
  exclude  TEXT,
  slow     INTEGER NOT NULL DEFAULT 0,    -- network mount: skip hashing and watching
  enabled  INTEGER NOT NULL DEFAULT 1,
  last_scan INTEGER
) STRICT;

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
