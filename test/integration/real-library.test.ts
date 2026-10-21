// Runs only on a machine that has a real X-Music library, as a sanity check that the duplicate
// finder and merge preview behave on real data rather than only on fixtures.

import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { copyLiveLibrary, hasLiveLibrary } from '../helpers/live'

import { findDuplicates } from '@main/library/duplicates'
import { mergePreview } from '@main/library/merge'

describe.runIf(hasLiveLibrary())('against the real library on this machine', () => {
  it('finds duplicates and previews a merge without throwing', () => {
    // Copy first: this test must never touch the live database.
    const db = new DatabaseSync(copyLiveLibrary('x-music-real-check.db'))

    const total = (db.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n
    expect(total).toBeGreaterThan(0)

    const groups = findDuplicates(db as never)
    const byReason: Record<string, number> = {}
    for (const g of groups) byReason[g.reason] = (byReason[g.reason] ?? 0) + 1
    console.log(`  by reason: ${JSON.stringify(byReason)}`)
    console.log(`  real library: ${total} tracks, ${groups.length} duplicate groups`)
    const fuzzy = groups.filter((g) => g.reason === 'fuzzy')
    console.log(`  sample fuzzy groups:`)
    for (const g of fuzzy.slice(0, 6)) {
      console.log(`    [${g.members.length}] ` + g.members.map((m) =>
        `artist=${JSON.stringify(m.artist)} title=${JSON.stringify(m.title)} len=${m.lengthMs}`
      ).join('  ||  '))
    }
    for (const g of groups.slice(0, 3)) {
      console.log(`    ${g.confidence.padEnd(8)} ${g.reason.padEnd(16)} ${g.members.length} tracks` +
        ` — ${g.members[0]!.artist ?? '?'} / ${g.members[0]!.title ?? '?'}`)
    }

    if (groups.length > 0) {
      const ids = groups[0]!.members.map((m) => m.trackId)
      const p = mergePreview(db as never, ids)

      expect(p.ids).toEqual(ids)
      expect(p.fields.length).toBeGreaterThan(0)
      expect(ids).toContain(p.survivor)

      // The preview must survive the IPC boundary.
      expect(() => structuredClone(p)).not.toThrow()

      const conflicts = p.fields.filter((f) => f.conflict).map((f) => f.field)
      console.log(`    preview: ${p.media.length} media, conflicts: ${conflicts.join(', ') || 'none'}`)
    }

    db.close()
  })
})
