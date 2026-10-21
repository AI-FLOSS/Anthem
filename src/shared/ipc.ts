// The IPC contract. Both the main process and the renderer import this module, so the boundary is
// type-checked end to end with no codegen step.

import type { FilterNode, SortKey, Limit } from './filter'
import type { FieldDescriptor } from './fields'

export interface LibraryStats {
  tracks: number
  media: number
  albums: number
  missing: number
  totalMs: number
  schemaVersion: number
  path: string
}

export interface TrackRow {
  id: number
  title: string | null
  artist: string | null
  album: string | null
  year: number | null
  track_number: number | null
  length_ms: number | null
  rating: number | null
  play_count: number
}

export interface GroupRow {
  gid: number | string | null
  label: string | null
  n: number
  total_ms: number
}

export interface QueryRequest {
  filter: FilterNode
  sort?: readonly SortKey[]
  limit?: Limit
  offset?: number
}

export interface SafetyStatus {
  readOnly: boolean
  pinned: boolean
  reason: string
}

export interface GmbPreview {
  path: string
  exists: boolean
  version?: string
  baseFolder?: string
  songs: number
  savedFilters: number
  savedLists: number
  playHistoryEntries: number
  unmappedColumns: string[]
  error?: string
}

export interface ImportReport {
  songsRead: number
  tracksCreated: number
  mediaCreated: number
  missingFlagged: number
  playHistoryRows: number
  playlistsCreated: number
  savedFiltersFound: number
  unmappedColumns: string[]
  notes: string[]
}

export interface Root {
  id: number
  path: string
  enabled: boolean
  slow: boolean
  lastScan: number | null
}

export interface ScanProgress {
  phase: 'walking' | 'reading' | 'finishing'
  found: number
  processed: number
  currentPath?: string
}

export type FileOutcome = 'new' | 'matched' | 'moved' | 'unchanged' | 'error' | 'missing'

export interface FileResult {
  path: string
  outcome: FileOutcome
  detail?: string
  trackId?: number
}

export interface ScanReport {
  filesFound: number
  filesRead: number
  filesSkipped: number
  tracksCreated: number
  tracksMatched: number
  movesDetected: number
  markedMissing: number
  errors: { path: string; message: string }[]
  durationMs: number
}

export type Resolution = { kind: 'value'; from: number } | { kind: 'union' }

export interface FieldOption { from: number; value: string | number | null | string[] }

export interface PreviewField {
  field: string
  name: string
  multi: boolean
  conflict: boolean
  value?: string | number | null | string[]
  options?: FieldOption[]
  union?: string[]
}

export interface PreviewMedia {
  id: number
  from: number
  uri: string
  codec: string | null
  bitrate: number | null
  present: boolean
}

export interface MergePreview {
  ids: number[]
  survivor: number
  fields: PreviewField[]
  media: PreviewMedia[]
  statistics: {
    playCount: number
    skipCount: number
    rating: number | null
    firstPlayed: number | null
    lastPlayed: number | null
  }
  pinnedSources: number[]
}

export interface MergeResult {
  batchId: string
  survivor: number
  absorbed: number[]
  mediaMoved: number
  historyMoved: number
  playlistEntriesRepointed: number
}

export type DuplicateReason = 'audio_hash' | 'mb_recording_id' | 'tags' | 'fuzzy'

export interface DuplicateMember {
  trackId: number
  title: string | null
  artist: string | null
  album: string | null
  year: number | null
  lengthMs: number | null
  rating: number | null
  playCount: number
  mediaCount: number
  codecs: string
}

export interface DuplicateGroup {
  key: string
  reason: DuplicateReason
  confidence: 'certain' | 'likely' | 'possible'
  explanation: string
  members: DuplicateMember[]
}

export type RepeatMode = 'off' | 'all' | 'one'

export interface PlayerTrack {
  id: number
  title: string | null
  artist: string | null
  album: string | null
  lengthMs: number | null
  rating: number | null
}

export interface PlayerStatus {
  state: 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'
  track: PlayerTrack | null
  media: { id: number; uri: string; startMs: number | null; endMs: number | null; gainDb: number | null } | null
  positionMs: number
  durationMs: number | null
  volume: number
  repeat: RepeatMode
  shuffle: boolean
  queue: number[]
  contextLength: number
  contextIndex: number
  error?: string
}

export interface DetailMedia {
  id: number
  kind: string
  uri: string
  provider: string | null
  present: boolean
  preferred: boolean
  codec: string | null
  container: string | null
  bitrate: number | null
  bitrateMode: string | null
  samplerate: number | null
  channels: number | null
  bitsPerSample: number | null
  filesize: number | null
  mtime: number | null
  lastSeen: number | null
  qualityRank: number
  audioHashHex: string | null
  audioHashAlgo: string | null
  subtrackIndex: number
  startMs: number | null
  endMs: number | null
  tags: { field: string; value: string }[]
}

export interface TrackDetails {
  id: number
  title: string | null
  album: string | null
  albumId: number | null
  identity: {
    source: string
    key: string | null
    pinned: boolean
    mbRecordingId: string | null
    acoustid: string | null
  }
  fields: { field: string; name: string; value: string | null; multi: boolean }[]
  media: DetailMedia[]
  statistics: {
    rating: number | null
    playCount: number
    skipCount: number
    firstPlayed: number | null
    lastPlayed: number | null
    lastSkipped: number | null
    added: number
    modified: number
    bookmarkMs: number | null
  }
  loudness: { rgTrackGain: number | null; rgAlbumGain: number | null }
  history: { at: number; kind: 'play' | 'skip' }[]
  historyTotal: number
  merges: { batchId: string; at: number; absorbed: number }[]
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
}

/** Every channel the renderer may invoke, with its argument and result types. */
export interface XMusicApi {
  'app:info': () => AppInfo
  'library:stats': () => LibraryStats
  'library:query': (req: QueryRequest) => TrackRow[]
  'library:groupBy': (req: { filter: FilterNode; field: string }) => GroupRow[]
  'library:explain': (req: QueryRequest) => { sql: string; params: unknown[] }
  'fields:list': () => FieldDescriptor[]
  'theme:list': () => string[]
  'app:safety': () => SafetyStatus
  'import:gmbDefaultPath': () => string
  'import:gmbBrowse': () => string | null
  'import:gmbPreview': (path: string) => GmbPreview
  'import:gmbRun': (req: { path: string; statistics?: boolean; labels?: boolean; playlists?: boolean }) => ImportReport
  'library:reset': () => { cleared: boolean }
  'library:roots': () => Root[]
  'library:addRoot': () => Root | null
  'library:removeRoot': (id: number) => { removed: boolean }
  'library:scan': () => ScanReport
  'library:scanCancel': () => { cancelled: boolean }
  'tracks:mergePreview': (ids: number[]) => MergePreview
  'tracks:merge': (req: {
    ids: number[]
    survivor: number
    resolutions?: Record<string, Resolution>
  }) => MergeResult
  'tracks:unmerge': (batchId: string) => { batchId: string; restored: number[]; survivor: number }
  'app:log': (record: {
    level: 'critical' | 'error' | 'warn' | 'info' | 'debug'
    scope: string
    message: string
    data?: unknown
  }) => { logged: boolean }
  'app:logConfig': () => { spec: string | undefined }
  'tracks:details': (trackId: number) => TrackDetails | null
  /** Resolves cover art lazily; returns an x-music-art:// url, or null when there is none. */
  'art:forTrack': (req: { trackId: number; size?: number }) =>
    { url: string | null; source: string }
  'art:rescan': () => { forgotten: number }
  'tracks:reveal': (uri: string) => { revealed: boolean }
  'player:status': () => PlayerStatus
  'player:playTrack': (req: { trackId: number; context?: number[]; index?: number }) => PlayerStatus
  'player:toggle': () => PlayerStatus
  'player:next': () => PlayerStatus
  'player:previous': () => PlayerStatus
  'player:stop': () => PlayerStatus
  'player:seek': (positionMs: number) => PlayerStatus
  'player:volume': (volume: number) => PlayerStatus
  'player:enqueue': (req: { trackIds: number[]; position?: 'end' | 'next' }) => PlayerStatus
  'player:dequeue': (index: number) => PlayerStatus
  'player:clearQueue': () => PlayerStatus
  'player:repeat': (mode: RepeatMode) => PlayerStatus
  'player:shuffle': (on: boolean) => PlayerStatus
  'tracks:duplicates': (opts?: {
    reasons?: DuplicateReason[]
    lengthToleranceMs?: number
    limit?: number
  }) => DuplicateGroup[]
}

/** Pushed from the main process; the renderer subscribes rather than polling. */
export interface XMusicEvents {
  'scan:progress': ScanProgress
  /** Batched, because one message per file would flood the bridge on a large library. */
  'scan:files': FileResult[]
  'scan:done': ScanReport
  'player:status': PlayerStatus
  /** Throttled; the UI interpolates between ticks rather than being fed every frame. */
  'player:position': { positionMs: number; durationMs: number | null }
}

export type EventName = keyof XMusicEvents
export const EVENT_CHANNEL = 'x-music:event'

/**
 * A value that structured clone rejects, such as a Proxy, cannot cross Electron's IPC boundary —
 * it fails with "An object could not be cloned". Rather than making every call site
 * remember to unwrap, the bridge enforces its own contract: a value that already survives
 * structured cloning passes through untouched, and anything else is flattened to plain JSON.
 * Every argument in this contract is JSON-shaped, so nothing is lost.
 */
export function toCloneable(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  try {
    structuredClone(value)
    return value
  } catch {
    return JSON.parse(JSON.stringify(value))
  }
}

export type Channel = keyof XMusicApi
export type ApiArgs<C extends Channel> = Parameters<XMusicApi[C]>
export type ApiResult<C extends Channel> = ReturnType<XMusicApi[C]>

export const CHANNELS: readonly Channel[] = [
  'app:info', 'app:safety', 'library:stats', 'library:query', 'library:groupBy',
  'library:explain', 'library:reset', 'fields:list', 'theme:list',
  'import:gmbDefaultPath', 'import:gmbBrowse', 'import:gmbPreview', 'import:gmbRun',
  'library:roots', 'library:addRoot', 'library:removeRoot', 'library:scan', 'library:scanCancel',
  'tracks:mergePreview', 'tracks:merge', 'tracks:unmerge', 'tracks:duplicates',
  'app:log', 'app:logConfig', 'tracks:details', 'tracks:reveal',
  'art:forTrack', 'art:rescan',
  'player:status', 'player:playTrack', 'player:toggle', 'player:next', 'player:previous',
  'player:stop', 'player:seek', 'player:volume', 'player:enqueue', 'player:dequeue',
  'player:clearQueue', 'player:repeat', 'player:shuffle'
]
