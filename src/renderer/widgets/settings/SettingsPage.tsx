import { useState } from 'preact/hooks'
import { ipc } from '../../lib/ipc'
import { cx } from '../../lib/cx'
import { Page } from '../../lib/Page'
import type { AppInfo, SafetyStatus } from '@shared/ipc'
import { library } from '../../stores/library'
import { GmbImport } from './GmbImport'
import { ScanPanel } from './ScanPanel'
import { DuplicatesPanel } from './DuplicatesPanel'
import s from './SettingsPage.module.css'

const sections = [
  { id: 'library', label: 'Library' },
  { id: 'folders', label: 'Folders' },
  { id: 'import', label: 'Import' },
  { id: 'duplicates', label: 'Duplicates' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'about', label: 'About' }
] as const

export type Section = (typeof sections)[number]['id']

const duration = (ms: number): string => {
  const h = Math.floor(ms / 3_600_000)
  const d = Math.floor(h / 24)
  return d > 0 ? `${d}d ${h % 24}h` : `${h}h`
}

export function SettingsPage({
  info = null,
  safety = null,
  theme = 'system',
  density = 'normal',
  initialSection = 'library',
  onclose,
  onTheme,
  onDensity
}: {
  info?: AppInfo | null
  safety?: SafetyStatus | null
  theme?: 'light' | 'dark' | 'system'
  density?: 'compact' | 'normal' | 'comfortable'
  initialSection?: Section
  onclose?: () => void
  onTheme?: (t: 'light' | 'dark' | 'system') => void
  onDensity?: (d: 'compact' | 'normal' | 'comfortable') => void
}) {
  // The prop only chooses where to open; the nav owns the value from then on.
  const [section, setSection] = useState<Section>(initialSection)
  const [clearing, setClearing] = useState(false)

  async function clearLibrary(): Promise<void> {
    setClearing(true)
    try {
      await ipc('library:reset')
      await library.refresh()
    } finally {
      setClearing(false)
    }
  }

  const nav = sections.map((sec) => (
    <button key={sec.id} class={cx(s.navButton, section === sec.id && s.active)}
            onClick={() => setSection(sec.id)}>{sec.label}</button>
  ))

  const stats = library.stats

  return (
    <Page title="Settings" onclose={onclose} nav={nav}>
      {section === 'library' ? (
        <section class={s.section}>
          <h2 class={s.heading}>Library</h2>

          <div class={s.field}>
            <span class={s.label}>Database</span>
            <code class={s.code}>{stats?.path ?? '—'}</code>
          </div>

          <div class={s.field}>
            <span class={s.label}>Contents</span>
            <span>
              {stats ? (
                <>
                  {stats.tracks.toLocaleString()} tracks ·{' '}
                  {stats.media.toLocaleString()} files ·{' '}
                  {stats.albums.toLocaleString()} albums ·{' '}
                  {duration(stats.totalMs)}
                  {stats.missing > 0 && <> · {stats.missing} missing</>}
                </>
              ) : '—'}
            </span>
          </div>

          <div class={s.field}>
            <span class={s.label}>File safety</span>
            <span>
              {safety ? (
                <>
                  <strong class={cx(safety.readOnly && s.ok)}>{safety.readOnly ? 'Read-only' : 'Writes enabled'}</strong>
                  <span class={s.hint}>{safety.reason}</span>
                  {safety.pinned ? (
                    <span class={s.hint}>
                      Pinned by the environment. Unset <code class={s.code}>X_MUSIC_FORCE_READ_ONLY</code> to change it.
                    </span>
                  ) : (
                    <span class={s.hint}>
                      X-Music cannot write tags yet, so this is a guarantee rather than a preference.
                    </span>
                  )}
                </>
              ) : '—'}
            </span>
          </div>

          <div class={s.field}>
            <span class={s.label}>Danger zone</span>
            <span>
              <button class={s.danger} disabled={clearing} onClick={clearLibrary}>
                {clearing ? 'Clearing…' : 'Clear library database'}
              </button>
              <span class={s.hint}>Removes every track, playlist and statistic. Files are untouched.</span>
            </span>
          </div>
        </section>
      ) : section === 'folders' ? (
        <ScanPanel />
      ) : section === 'import' ? (
        <GmbImport ondone={onclose} />
      ) : section === 'duplicates' ? (
        <DuplicatesPanel />
      ) : section === 'appearance' ? (
        <section class={s.section}>
          <h2 class={s.heading}>Appearance</h2>

          <div class={s.field}>
            <span class={s.label}>Theme</span>
            <div class={s.choices}>
              {(['system', 'light', 'dark'] as const).map((t) => (
                <button key={t} class={cx(s.choice, theme === t && s.sel)} onClick={() => onTheme?.(t)}>{t}</button>
              ))}
            </div>
          </div>

          <div class={s.field}>
            <span class={s.label}>Density</span>
            <div class={s.choices}>
              {(['compact', 'normal', 'comfortable'] as const).map((d) => (
                <button key={d} class={cx(s.choice, density === d && s.sel)} onClick={() => onDensity?.(d)}>{d}</button>
              ))}
            </div>
          </div>

          <p class={s.hint}>
            Colours come from the Halon token set; density maps onto the row-height scale, so both
            apply everywhere without a component knowing about them.
          </p>
        </section>
      ) : (
        <section class={s.section}>
          <h2 class={s.heading}>About</h2>
          <div class={s.field}>
            <span class={s.label}>X-Music</span>
            <span>{info?.version ?? '—'}</span>
          </div>
          <div class={s.field}>
            <span class={s.label}>Runtime</span>
            <span>
              {info
                ? `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node} · ${info.platform}`
                : '—'}
            </span>
          </div>
          <div class={s.field}>
            <span class={s.label}>Last query</span>
            <code class={cx(s.code, s.sql)}>{library.lastSql || '—'}</code>
          </div>
        </section>
      )}
    </Page>
  )
}
