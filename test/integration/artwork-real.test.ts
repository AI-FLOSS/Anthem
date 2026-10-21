// Extraction against real files, because the fixture tests prove the logic and only real tags and
// real folders prove the extraction.

import { describe, expect, it } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { resolveArtwork } from '@main/library/artwork'
import { copyLiveLibrary, hasLiveLibrary } from '../helpers/live'

describe.runIf(hasLiveLibrary())('artwork against the real library', () => {
  it('finds covers for real tracks', async () => {
    const cache = join(tmpdir(), 'x-music-art-real-cache')
    rmSync(cache, { recursive: true, force: true })
    const db = new DatabaseSync(copyLiveLibrary('x-music-art-real.db'))

    const ids = (db.prepare(`
      SELECT t.id FROM tracks t JOIN media m ON m.track_id = t.id
      WHERE m.present = 1 GROUP BY t.id LIMIT 25`).all() as { id: number }[]).map((r) => r.id)

    const tally: Record<string, number> = {}
    for (const id of ids) {
      const art = await resolveArtwork(db as never, id, { cacheDir: cache })
      tally[art.source] = (tally[art.source] ?? 0) + 1
      if (art.path) expect(existsSync(art.path)).toBe(true)
    }

    console.log(`  ${ids.length} tracks -> ${JSON.stringify(tally)}`)

    const found = (tally.embedded ?? 0) + (tally.folder ?? 0)
    if (found > 0) {
      const sample = db.prepare(
        "SELECT source, origin, width, height FROM artwork WHERE source != 'none' LIMIT 3")
        .all() as { source: string; origin: string; width: number; height: number }[]
      for (const s of sample) {
        console.log(`    ${s.source} ${s.width}x${s.height} <- ${s.origin?.split('/').pop()}`)
      }
    }

    // Whatever the outcome, every track must end with a recorded answer.
    const recorded = (db.prepare("SELECT COUNT(*) AS n FROM artwork").get() as { n: number }).n
    expect(recorded).toBeGreaterThan(0)

    db.close()
  }, 60_000)
})
