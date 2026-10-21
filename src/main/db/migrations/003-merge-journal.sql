-- A merge deletes track rows, which makes it the most destructive operation in X-Music that does not
-- touch a file. Every merge records enough to put the library back exactly as it was, so the action
-- is reversible rather than merely careful (DESIGN-SPEC §9.4.3).

CREATE TABLE merge_journal (
  id          INTEGER PRIMARY KEY,
  batch_id    TEXT NOT NULL,
  at          INTEGER NOT NULL,
  survivor_id INTEGER NOT NULL,
  -- Full pre-merge state of every participating track, including the survivor, as JSON.
  snapshot    TEXT NOT NULL,
  undone      INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX merge_journal_batch ON merge_journal(batch_id);
CREATE INDEX merge_journal_at ON merge_journal(at);
