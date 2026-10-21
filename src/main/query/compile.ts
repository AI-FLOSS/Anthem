// Compiles a filter AST to parameterized SQL (DESIGN-SPEC §4.2).
//
// This is one of the two compilation targets. The other is a native predicate over the in-memory
// index; a property test asserts the two always return identical id sets, which is the only thing
// keeping the fast path honest.

import { field, type FieldDescriptor } from '@shared/fields'
import { isGroup, type FilterNode, type LeafNode, type RelativeDate, type SortKey, type Limit } from '@shared/filter'

export interface CompiledQuery {
  sql: string
  params: unknown[]
}

const MS: Record<RelativeDate['unit'], number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_536_000_000
}

class Compiler {
  readonly params: unknown[] = []

  constructor(readonly now: number) {}

  private p(v: unknown): string {
    this.params.push(v)
    return '?'
  }

  /** SQL expression yielding the field's scalar value for the current track row `t`. */
  private scalar(d: FieldDescriptor): string {
    if (d.storage === 'column') return `t.${d.column ?? d.id}`
    if (d.storage === 'computed') return d.expr!
    if (d.storage === 'extra')
      return `(SELECT value FROM track_extras WHERE track_id = t.id AND field_id = ${d.fieldId})`
    if (d.storage === 'media') return `m.${d.column ?? d.id}`
    throw new Error(`field ${d.id} is not scalar`)
  }

  private like(expr: string, pattern: string, cs: boolean): string {
    // LIKE is case-insensitive for ASCII by default; the case-sensitive path needs GLOB-free
    // exactness, so compare with a binary collation instead.
    if (!cs) return `${expr} LIKE ${this.p(pattern)} ESCAPE '\\'`
    return `${expr} LIKE ${this.p(pattern)} ESCAPE '\\' COLLATE BINARY`
  }

  private esc(s: string): string {
    return s.replace(/[\\%_]/g, (m) => `\\${m}`)
  }

  private setPredicate(d: FieldDescriptor, node: LeafNode): string {
    const values = (Array.isArray(node.value) ? node.value : [node.value]) as string[]
    const member = (v: string): string =>
      `EXISTS (SELECT 1 FROM track_values tv JOIN values_ vv ON vv.id = tv.value_id
               WHERE tv.track_id = t.id AND tv.field_id = ${d.fieldId} AND vv.value = ${this.p(v)})`

    switch (node.op) {
      case 'any':
        return values.length ? `(${values.map(member).join(' OR ')})` : '0'
      case 'all':
        return values.length ? `(${values.map(member).join(' AND ')})` : '1'
      case 'none':
        return values.length ? `NOT (${values.map(member).join(' OR ')})` : '1'
      case 'count': {
        const n = Number(node.value)
        return `(SELECT COUNT(*) FROM track_values tv
                 WHERE tv.track_id = t.id AND tv.field_id = ${d.fieldId}) = ${this.p(n)}`
      }
      case 'empty':
        return `NOT EXISTS (SELECT 1 FROM track_values tv
                            WHERE tv.track_id = t.id AND tv.field_id = ${d.fieldId})`
      case 'defined':
        return `EXISTS (SELECT 1 FROM track_values tv
                        WHERE tv.track_id = t.id AND tv.field_id = ${d.fieldId})`
      default:
        throw new Error(`operator ${node.op} is not valid on set field ${d.id}`)
    }
  }

  leaf(node: LeafNode): string {
    const d = field(node.field)

    if (d.storage === 'multi') return this.setPredicate(d, node)

    if (node.op === 'matches') {
      return `t.id IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ${this.p(node.value)})`
    }

    if (node.op === 'in_playlist') {
      return `EXISTS (SELECT 1 FROM playlist_tracks pt
                      WHERE pt.track_id = t.id AND pt.playlist_id = ${this.p(node.value)})`
    }

    const e = this.scalar(d)
    const predicate = this.applyOp(e, node)

    // A physical property belongs to a source, not to the music. The track matches when any of its
    // media does, which is also what makes "I have this in FLAC and MP3" behave sensibly.
    if (d.storage === 'media')
      return `EXISTS (SELECT 1 FROM media m WHERE m.track_id = t.id AND ${predicate})`

    return predicate
  }

  private applyOp(e: string, node: LeafNode): string {
    const v = node.value
    const cs = node.cs ?? false

    switch (node.op) {
      case 'is':         return `${e} = ${this.p(v)}`
      case 'not_is':     return `${e} IS NOT ${this.p(v)}`
      case 'contains':   return this.like(e, `%${this.esc(String(v))}%`, cs)
      case 'starts':     return this.like(e, `${this.esc(String(v))}%`, cs)
      case 'ends':       return this.like(e, `%${this.esc(String(v))}`, cs)
      case 'regex':      return `${e} REGEXP ${this.p(v)}`
      case '>':          return `${e} > ${this.p(v)}`
      case '<':          return `${e} < ${this.p(v)}`
      case '>=':         return `${e} >= ${this.p(v)}`
      case '<=':         return `${e} <= ${this.p(v)}`
      case 'between': {
        const [lo, hi] = v as readonly number[]
        return `${e} BETWEEN ${this.p(lo)} AND ${this.p(hi)}`
      }
      case 'not_between': {
        const [lo, hi] = v as readonly number[]
        return `${e} NOT BETWEEN ${this.p(lo)} AND ${this.p(hi)}`
      }
      case 'empty':      return `(${e} IS NULL OR ${e} = '')`
      case 'defined':    return `(${e} IS NOT NULL AND ${e} != '')`
      case 'before':     return `${e} < ${this.p(v)}`
      case 'after':      return `${e} > ${this.p(v)}`
      case 'in_last': {
        const { n, unit } = v as RelativeDate
        return `(${e} IS NOT NULL AND ${e} >= ${this.p(this.now - n * MS[unit])})`
      }
      case 'not_in_last': {
        const { n, unit } = v as RelativeDate
        return `(${e} IS NULL OR ${e} < ${this.p(this.now - n * MS[unit])})`
      }
      case 'top':
        return `t.id IN (SELECT id FROM tracks WHERE ${e.replace(/\bt\./g, '')} IS NOT NULL
                         ORDER BY ${e.replace(/\bt\./g, '')} DESC LIMIT ${this.p(Number(v))})`
      case 'bottom':
        return `t.id IN (SELECT id FROM tracks WHERE ${e.replace(/\bt\./g, '')} IS NOT NULL
                         ORDER BY ${e.replace(/\bt\./g, '')} ASC LIMIT ${this.p(Number(v))})`
      default:
        throw new Error(`unhandled operator: ${node.op}`)
    }
  }

  node(n: FilterNode): string {
    if (!isGroup(n)) return this.leaf(n)

    if (n.op === 'not') {
      if (n.children.length !== 1) throw new Error('not takes exactly one child')
      // X-Music uses two-valued logic: a predicate is true or false for a track, never unknown.
      // Without the COALESCE, SQL's NULL propagation would silently drop tracks with a missing
      // value from a negated filter — so "not rated 5 stars" would exclude unrated tracks.
      return `NOT COALESCE((${this.node(n.children[0]!)}), 0)`
    }
    if (n.children.length === 0) return n.op === 'and' ? '1' : '0'

    const joiner = n.op === 'and' ? ' AND ' : ' OR '
    return `(${n.children.map((c) => this.node(c)).join(joiner)})`
  }
}

function orderBy(sort: readonly SortKey[] | undefined, c: Compiler): string {
  if (!sort?.length) return ''
  const keys = sort.map((k) => {
    if (k.field === 'random') return 'RANDOM()'
    const d = field(k.field)
    const dir = k.dir === 'desc' ? 'DESC' : 'ASC'
    const expr =
      d.storage === 'column' ? `t.${d.column ?? d.id}`
      : d.storage === 'computed' ? d.expr!
      : d.storage === 'media'
        ? `(SELECT mm.${d.column ?? d.id} FROM media mm WHERE mm.track_id = t.id
             ORDER BY mm.quality_rank DESC, mm.id LIMIT 1)`
      : `(SELECT value FROM track_extras WHERE track_id = t.id AND field_id = ${d.fieldId})`
    // NULLs sort last in both directions, which is what a listener expects.
    return `${expr} IS NULL, ${expr} ${dir}`
  })
  return ` ORDER BY ${keys.join(', ')}`
}

export function compileFilter(
  node: FilterNode,
  opts: { sort?: readonly SortKey[]; limit?: Limit; select?: string; now?: number } = {}
): CompiledQuery {
  const c = new Compiler(opts.now ?? Date.now())
  const where = c.node(node)
  const select = opts.select ?? 't.id'

  let sql = `SELECT ${select} FROM tracks t WHERE ${where}`
  sql += orderBy(opts.sort, c)

  if (opts.limit && (opts.limit.by ?? 'tracks') === 'tracks') {
    sql += ` LIMIT ${c.params.push(opts.limit.count) && '?'}`
  }

  return { sql, params: c.params }
}

/** Counts per distinct value of a field — what the browser panes render. */
export function compileGroupBy(node: FilterNode, groupField: string, now = Date.now()): CompiledQuery {
  const c = new Compiler(now)
  const where = c.node(node)
  const d = field(groupField)

  if (d.storage === 'multi') {
    return {
      sql: `SELECT vv.id AS gid, vv.value AS label, COUNT(*) AS n,
                   SUM(COALESCE(t.length_ms, 0)) AS total_ms
            FROM tracks t
            JOIN track_values tv ON tv.track_id = t.id AND tv.field_id = ${d.fieldId}
            JOIN values_ vv ON vv.id = tv.value_id
            WHERE ${where}
            GROUP BY vv.id ORDER BY COALESCE(vv.sort_key, vv.value)`,
      params: c.params
    }
  }

  const expr =
    d.storage === 'column' ? `t.${d.column ?? d.id}`
    : d.storage === 'media'
      ? `(SELECT mm.${d.column ?? d.id} FROM media mm WHERE mm.track_id = t.id
           ORDER BY mm.quality_rank DESC, mm.id LIMIT 1)`
    : d.expr!
  return {
    sql: `SELECT ${expr} AS gid, ${expr} AS label, COUNT(*) AS n,
                 SUM(COALESCE(t.length_ms, 0)) AS total_ms
          FROM tracks t WHERE ${where}
          GROUP BY ${expr} ORDER BY ${expr} IS NULL, ${expr}`,
    params: c.params
  }
}
