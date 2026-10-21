// The performance budget from DESIGN-SPEC §12, expressed as runnable benchmarks. These exist so a
// regression shows up as a number rather than as a vague feeling that the app got slower.

import { bench, describe } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { compileFilter, compileGroupBy } from '@main/query/compile'
import { selectIds } from '@main/query/evaluate'
import { and, or, leaf, not } from '@shared/filter'
import { makeCorpus, FIXED_NOW } from '../test/helpers/corpus'
import { loadCorpus } from '../test/helpers/sqlite'

const SIZE = Number(process.env.X_MUSIC_BENCH_SIZE ?? 50_000)

const corpus = makeCorpus(SIZE, 2024)
const db = new DatabaseSync(':memory:')
db.exec('PRAGMA foreign_keys = ON')
db.exec(readFileSync(join(process.cwd(), 'src/main/db/migrations/001-initial.sql'), 'utf8'))
db.function('REGEXP', (p: unknown, v: unknown) => {
  try { return new RegExp(String(p), 'u').test(String(v)) ? 1 : 0 } catch { return 0 }
})
loadCorpus(db, corpus)

const SIMPLE = leaf('rating', '>=', 80)
const COMPOUND = and(
  leaf('rating', '>=', 60),
  leaf('genre', 'any', ['Jazz', 'Blues']),
  leaf('last_played', 'not_in_last', { n: 30, unit: 'day' }),
  or(leaf('year', 'between', [1955, 1975]), leaf('tags', 'any', ['essential'])),
  not(leaf('codec', 'is', 'mp3'))
)

const run = (node: Parameters<typeof compileFilter>[0]): void => {
  const { sql, params } = compileFilter(node, { now: FIXED_NOW })
  db.prepare(sql).all(...(params as never[]))
}

describe(`SQL filter over ${SIZE.toLocaleString()} tracks (budget: 100ms)`, () => {
  bench('simple scalar predicate', () => run(SIMPLE))
  bench('compound predicate with sets, dates and negation', () => run(COMPOUND))
  bench('full-library scan', () => run(and()))
})

describe(`native predicate over ${SIZE.toLocaleString()} tracks (budget: 100ms)`, () => {
  bench('simple scalar predicate', () => {
    selectIds(SIMPLE, corpus.tracks, { now: FIXED_NOW })
  })
  bench('compound predicate with sets, dates and negation', () => {
    selectIds(COMPOUND, corpus.tracks, { now: FIXED_NOW })
  })
})

describe(`group-by over ${SIZE.toLocaleString()} tracks (budget: 100ms)`, () => {
  bench('group by genre (multi-value)', () => {
    const { sql, params } = compileGroupBy(and(), 'genre', FIXED_NOW)
    db.prepare(sql).all(...(params as never[]))
  })
  bench('group by year (scalar)', () => {
    const { sql, params } = compileGroupBy(and(), 'year', FIXED_NOW)
    db.prepare(sql).all(...(params as never[]))
  })
})

describe(`sort over ${SIZE.toLocaleString()} tracks (budget: 150ms)`, () => {
  bench('sort by album then track number', () => {
    const { sql, params } = compileFilter(and(), {
      now: FIXED_NOW,
      sort: [{ field: 'album' }, { field: 'track_number' }]
    })
    db.prepare(sql).all(...(params as never[]))
  })
})
