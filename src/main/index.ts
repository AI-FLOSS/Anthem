import { app, BrowserWindow, nativeTheme, protocol, shell, net } from 'electron'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

import { openLibrary, libraryPath } from './db'
import { registerIpc } from './ipc'
import { initSafety, safetyStatus } from './safety'
import { describeLogging, log } from './log'
import { artCacheDir } from './artcache'

const isDev = !app.isPackaged

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#060b14' : '#f1f5f9',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      // electron-vite emits an ESM preload as .mjs; loading .js here silently yields no bridge.
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // A player must keep ticking when its window is hidden or occluded; Chromium otherwise
      // throttles timers to about once a minute, stalling position updates and queue advances.
      backgroundThrottling: false
    }
  })

  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

// Cached covers cannot be served over file:// under the renderer's CSP, so they get their own
// scheme. Registered before ready, as Electron requires.
protocol.registerSchemesAsPrivileged([{
  scheme: 'x-music-art',
  privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false }
}])

app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

app.whenReady().then(() => {
  // X-Music's own directories are the only paths it may ever write to (see safety.ts).
  initSafety([app.getPath('userData'), join(app.getPath('temp'), 'x-music')])

  log.info('starting', { logging: describeLogging(), version: app.getVersion() })

  // The url carries the cache path; only files inside the cache directory are served.
  protocol.handle('x-music-art', (request) => {
    const url = new URL(request.url)
    const file = decodeURIComponent(url.pathname)
    const root = artCacheDir()

    if (!file.startsWith(root)) {
      log.warn('refused art outside the cache', { file })
      return new Response('forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(file).toString())
  })

  const db = openLibrary()
  const safety = safetyStatus()
  log.info(safety.reason)
  log.info('library opened', { path: libraryPath() })
  registerIpc(db)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('before-quit', () => db.close())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
