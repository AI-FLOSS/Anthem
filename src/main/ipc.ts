import { ipcMain, app, dialog, shell, BrowserWindow } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { BUILTIN_FIELDS } from '@shared/fields'
import type { XMusicApi, Channel, GroupRow, TrackRow } from '@shared/ipc'
import { compileFilter, compileGroupBy } from './query/compile'
import { stats, type DB } from './db'
import { safetyStatus } from './safety'
import { defaultGmbrcPath, parseGmbrc } from './import/gmbrc'
import { importGmbrc } from './import/gmb-import'
import { scanRoots } from './library/scan'
import { mergePreview, mergeTracks, unmerge } from './library/merge'
import { findDuplicates } from './library/duplicates'
import { trackDetails } from './library/details'
import { forgetMisses, resolveArtwork, thumbnail } from './library/artwork'
import { artCacheDir, resizeImage } from './artcache'
import { logFromRenderer, logger } from './log'
import { Player } from './play/player'
import { MpvEngine, findMpv } from './play/mpv'
import { NullEngine } from './play/engine'
import {
  EVENT_CHANNEL, type XMusicEvents, type EventName, type FileResult, type Root
} from '@shared/ipc'

// Album lives on the albums table and artist in track_values, so the row projection has to
// resolve both rather than reading columns that no longer exist on tracks.
const TRACK_COLUMNS = `
  t.id, t.title, t.year, t.track_number, t.length_ms, t.rating, t.play_count,
  (SELECT a.name FROM albums a WHERE a.id = t.album_id) AS album,
  (SELECT vv.value FROM track_values tv JOIN values_ vv ON vv.id = tv.value_id
    WHERE tv.track_id = t.id AND tv.field_id = 1 ORDER BY tv.ordinal LIMIT 1) AS artist`

type Handlers = { [C in Channel]: (...args: Parameters<XMusicApi[C]>) => ReturnType<XMusicApi[C]> }

function emit<E extends EventName>(name: E, payload: XMusicEvents[E]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(EVENT_CHANNEL, { name, payload })
  }
}

export function registerIpc(db: DB): void {
  // A scan runs at most once at a time; the flag is what cancel flips.
  let scanning: { aborted: boolean } | null = null

  // Without mpv the app still runs and the library still works; only audio is unavailable, and the
  // player reports that plainly rather than failing at the first click.
  const playLog = logger('play')
  const mpvPath = findMpv()
  if (!mpvPath) playLog.warn('mpv not found; playback is disabled', { hint: 'set X_MUSIC_MPV' })
  else playLog.info('using mpv', { path: mpvPath })

  const player = new Player(
    db as never,
    mpvPath
      ? new MpvEngine({ binary: mpvPath, onLog: (line) => playLog.debug(`mpv: ${line}`) })
      : new NullEngine(),
    { replayGain: 'track' }
  )

  player.subscribe((event, payload) => {
    if (event === 'status') emit('player:status', payload as never)
    else if (event === 'position') emit('player:position', payload as never)
  })

  const handlers: Handlers = {
    'app:info': () => ({
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node,
      platform: process.platform
    }),

    'library:stats': () => stats(db),

    'library:query': (req) => {
      const { sql, params } = compileFilter(req.filter, {
        sort: req.sort,
        limit: req.limit,
        select: TRACK_COLUMNS
      })
      const paged = req.offset ? `${sql} OFFSET ${Number(req.offset)}` : sql
      return db.prepare(paged).all(...(params as never[])) as TrackRow[]
    },

    'library:groupBy': (req) => {
      const { sql, params } = compileGroupBy(req.filter, req.field)
      return db.prepare(sql).all(...(params as never[])) as GroupRow[]
    },

    'library:explain': (req) =>
      compileFilter(req.filter, { sort: req.sort, limit: req.limit }),

    'fields:list': () => [...BUILTIN_FIELDS],

    'theme:list': () => ['halon-light', 'halon-dark'],

    'app:safety': () => safetyStatus(),

    'import:gmbDefaultPath': () => defaultGmbrcPath(homedir()),

    'import:gmbBrowse': () => {
      const result = dialog.showOpenDialogSync({
        title: 'Select a gmusicbrowser configuration file',
        defaultPath: defaultGmbrcPath(homedir()),
        properties: ['openFile'],
        filters: [{ name: 'gmusicbrowser config', extensions: ['*'] }]
      })
      return result?.[0] ?? null
    },

    // Reads and parses without writing anything, so the user can see what an import would do.
    'import:gmbPreview': (path) => {
      if (!existsSync(path)) {
        return { path, exists: false, songs: 0, savedFilters: 0, savedLists: 0,
                 playHistoryEntries: 0, unmappedColumns: [] }
      }
      try {
        const data = parseGmbrc(readFileSync(path, 'utf8'))
        return {
          path,
          exists: true,
          version: data.version,
          baseFolder: data.baseFolder,
          songs: data.songs.length,
          savedFilters: data.savedFilters.length,
          savedLists: data.savedLists.length,
          playHistoryEntries: data.songs.reduce((n, s) => n + s.playHistory.length, 0),
          unmappedColumns: data.unmappedColumns
        }
      } catch (err) {
        return { path, exists: true, songs: 0, savedFilters: 0, savedLists: 0,
                 playHistoryEntries: 0, unmappedColumns: [], error: (err as Error).message }
      }
    },

    'import:gmbRun': (req) => {
      const data = parseGmbrc(readFileSync(req.path, 'utf8'))
      return importGmbrc(db as never, data, {
        statistics: req.statistics,
        labels: req.labels,
        playlists: req.playlists
      })
    },

    'library:roots': () =>
      (db.prepare('SELECT id, path, enabled, slow, last_scan FROM roots ORDER BY path').all() as
        { id: number; path: string; enabled: number; slow: number; last_scan: number | null }[])
        .map((r) => ({
          id: r.id, path: r.path, enabled: !!r.enabled, slow: !!r.slow, lastScan: r.last_scan
        })) as Root[],

    'library:addRoot': () => {
      const picked = dialog.showOpenDialogSync({
        title: 'Choose a music folder',
        properties: ['openDirectory', 'createDirectory']
      })
      const path = picked?.[0]
      if (!path) return null

      db.prepare('INSERT OR IGNORE INTO roots (path, enabled) VALUES (?, 1)').run(path)
      const row = db.prepare('SELECT id, path, enabled, slow, last_scan FROM roots WHERE path = ?')
        .get(path) as { id: number; path: string; enabled: number; slow: number; last_scan: number | null }
      return { id: row.id, path: row.path, enabled: !!row.enabled, slow: !!row.slow, lastScan: row.last_scan }
    },

    'library:removeRoot': (id) => {
      db.prepare('DELETE FROM roots WHERE id = ?').run(id)
      return { removed: true }
    },

    'library:scanCancel': () => {
      if (scanning) scanning.aborted = true
      return { cancelled: scanning !== null }
    },

    'library:scan': (() => {
      // Declared async so the handler returns a promise to the renderer's invoke().
      const run = async (): Promise<never> => {
        if (scanning) throw new Error('a scan is already running')

        const roots = (db.prepare('SELECT path FROM roots WHERE enabled = 1').all() as
          { path: string }[]).map((r) => r.path)
        if (roots.length === 0) throw new Error('no music folders configured')

        scanning = { aborted: false }

        // One IPC message per file would flood the bridge; flush in batches instead.
        let pending: FileResult[] = []
        const flush = (): void => {
          if (pending.length === 0) return
          emit('scan:files', pending)
          pending = []
        }

        try {
          const report = await scanRoots(db as never, roots, {
            signal: scanning,
            onProgress: (p) => emit('scan:progress', p),
            onFile: (r) => {
              pending.push(r)
              if (pending.length >= 40) flush()
            }
          })
          flush()
          db.prepare('UPDATE roots SET last_scan = ? WHERE enabled = 1').run(Date.now())
          emit('scan:done', report)
          return report as never
        } finally {
          scanning = null
        }
      }
      return run as never
    })(),

    'app:log': (record) => {
      logFromRenderer(record.level, record.scope, record.message, record.data)
      return { logged: true }
    },

    'app:logConfig': () => ({ spec: process.env.X_MUSIC_LOG }),

    'tracks:details': (trackId) => trackDetails(db as never, trackId) as never,

    'art:forTrack': (async (req: { trackId: number; size?: number }) => {
      const options = { cacheDir: artCacheDir(), resize: resizeImage }
      const art = await resolveArtwork(db as never, req.trackId, options)
      const path = req.size ? thumbnail(options, art, req.size) : art.path

      return {
        url: path ? `x-music-art://local${encodeURI(path)}` : null,
        source: art.source
      }
    }) as never,

    'art:rescan': () => ({ forgotten: forgetMisses(db as never) }),

    'tracks:reveal': (uri) => {
      // Showing a file is a read; it does not need the write guard.
      shell.showItemInFolder(uri)
      return { revealed: true }
    },

    'player:status': () => player.status() as never,

    'player:playTrack': (req) => {
      if (req.context) player.setContext(req.context, req.index ?? -1)
      void player.playTrack(req.trackId, req.index ?? -1)
      return player.status() as never
    },

    'player:toggle': () => { void player.toggle(); return player.status() as never },
    'player:next': () => { void player.next(true); return player.status() as never },
    'player:previous': () => { void player.previous(); return player.status() as never },
    'player:stop': () => { void player.stop(); return player.status() as never },
    'player:seek': (ms) => { void player.seek(ms); return player.status() as never },
    'player:volume': (v) => { void player.setVolume(v); return player.status() as never },

    'player:enqueue': (req) => {
      player.enqueue(req.trackIds, req.position ?? 'end')
      return player.status() as never
    },

    'player:dequeue': (index) => { player.dequeue(index); return player.status() as never },
    'player:clearQueue': () => { player.clearQueue(); return player.status() as never },
    'player:repeat': (mode) => { player.setRepeat(mode); return player.status() as never },
    'player:shuffle': (on) => { player.setShuffle(on); return player.status() as never },

    'tracks:mergePreview': (ids) => mergePreview(db as never, ids) as never,

    'tracks:merge': (req) => mergeTracks(db as never, req) as never,

    'tracks:unmerge': (batchId) => unmerge(db as never, batchId),

    'tracks:duplicates': (opts) => findDuplicates(db as never, opts ?? {}) as never,

    'library:reset': () => {
      db.exec(`DELETE FROM playlist_tracks; DELETE FROM playlists; DELETE FROM play_history;
               DELETE FROM track_values; DELETE FROM track_extras; DELETE FROM media;
               DELETE FROM tracks; DELETE FROM albums; DELETE FROM values_;`)
      return { cleared: true }
    }
  }

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, ...args) => (handler as (...a: unknown[]) => unknown)(...args))
  }
}
