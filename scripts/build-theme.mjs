// Generates themes/halon/halon.css from Halon's token document.
//
// Halon's tokens are the source; X-Music adds a player-specific layer derived from them, so a token
// update upstream flows through without hand-editing CSS (DESIGN-SPEC §5.4).

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tokens = JSON.parse(readFileSync(join(root, 'themes/halon/tokens.json'), 'utf8'))

// Player-specific tokens, expressed in terms of Halon's so they stay in sync.
const derived = (mode) => ({
  'media-progress': 'var(--accent)',
  'media-progress-track': 'var(--border-default)',
  'media-buffer': 'var(--border-hover)',
  'rating-on': 'var(--accent)',
  'rating-off': 'var(--border-control)',
  'rating-hover': 'var(--border-focus)',
  'waveform-played': 'var(--accent)',
  'waveform-unplayed': 'var(--border-default)',
  'row-even': 'transparent',
  'row-odd': 'transparent',
  'row-hover': 'var(--surface-navigation-hover)',
  'row-selected': 'color-mix(in srgb, var(--accent) 22%, var(--surface-default))',
  'row-selected-inactive': 'color-mix(in srgb, var(--accent) 10%, var(--surface-default))',
  'row-playing': 'color-mix(in srgb, var(--accent) 14%, var(--surface-default))',
  'column-header': 'var(--surface-secondary)',
  'column-separator': 'var(--border-default)',
  'drag-indicator': 'var(--accent)'
})

// Metric tokens follow Halon's THEME-DESIGN-GUIDE §4 rather than being reinvented.
const metrics = {
  'space-1': '2px', 'space-2': '4px', 'space-3': '8px', 'space-4': '12px',
  'space-5': '16px', 'space-6': '24px', 'space-7': '32px',
  'radius-sm': '4px', 'radius-md': '6px', 'radius-lg': '10px', 'radius-full': '999px',
  'control-height': '28px', 'control-height-sm': '22px', 'control-height-lg': '34px',
  'row-height-compact': '22px', 'row-height-normal': '28px', 'row-height-comfortable': '36px',
  'font-ui': "system-ui, -apple-system, 'Segoe UI', Cantarell, 'Noto Sans', sans-serif",
  'font-mono': "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
  'font-size-sm': '12px', 'font-size-md': '13px', 'font-size-lg': '15px',
  'transition-fast': '90ms ease', 'transition-base': '160ms ease'
}

const block = (vars) =>
  Object.entries(vars).map(([k, v]) => `  --${k}: ${v};`).join('\n')

const modeVars = (mode) => ({ ...tokens[mode], ...derived(mode) })

const css = `/* GENERATED FILE - do not edit. Built from themes/halon/tokens.json by scripts/build-theme.mjs. */

:root {
${block(metrics)}
${block(modeVars('light'))}
}

@media (prefers-color-scheme: dark) {
  :root {
${block(modeVars('dark')).replace(/^/gm, '  ')}
  }
}

/* The in-app theme toggle stamps data-theme on the root, and must win in both directions. */
:root[data-theme='light'] {
${block(modeVars('light'))}
}

:root[data-theme='dark'] {
${block(modeVars('dark'))}
}

/* Density switches the song-list row height without touching any component stylesheet. */
:root[data-density='compact']     { --row-height: var(--row-height-compact); }
:root[data-density='normal']      { --row-height: var(--row-height-normal); }
:root[data-density='comfortable'] { --row-height: var(--row-height-comfortable); }
:root                             { --row-height: var(--row-height-normal); }
`

writeFileSync(join(root, 'themes/halon/halon.css'), css)
console.log(`built themes/halon/halon.css (${css.split('\n').length} lines)`)
