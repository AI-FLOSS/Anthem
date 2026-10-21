// Transport is presentational until the mpv engine lands in M3; the widget contract is what
// matters now, since the layout document references widgets by id.

import { useState } from 'preact/hooks'
import { cx } from '../lib/cx'
import s from './PlayerBar.module.css'

export function PlayerBar() {
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)

  return (
    <footer class={s.player}>
      <div class={s.transport}>
        <button class={s.button} aria-label="Previous">⏮</button>
        <button class={cx(s.button, s.primary)} aria-label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying(!playing)}>
          {playing ? '⏸' : '▶'}
        </button>
        <button class={s.button} aria-label="Next">⏭</button>
      </div>

      <div class={s.cover} aria-hidden="true"></div>

      <div class={s.now}>
        <div class={s.title}>Nothing playing</div>
        <div class={s.sub}>X-Music</div>
      </div>

      <div class={s.seek}>
        <input
          class={s.range}
          type="range" min="0" max="1000"
          value={position}
          aria-label="Seek"
          onInput={(e) => setPosition(Number((e.currentTarget as HTMLInputElement).value))}
        />
      </div>

      <div class={s.right}>
        <input type="range" min="0" max="100" defaultValue="80" aria-label="Volume" class={cx(s.range, s.vol)} />
      </div>
    </footer>
  )
}
