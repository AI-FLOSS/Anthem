// Everything X-Music knows about one track. This is the first place the entity model is visible:
// a track is a piece of music, and the files are sources hanging off it (DESIGN-SPEC §6.5).

import { Fragment } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import type { TrackDetails } from '@shared/ipc'
import { ipc } from '../lib/ipc'
import { cx } from '../lib/cx'
import { Page } from '../lib/Page'
import { Stars } from './Stars'
import { Cover } from './Cover'
import s from './SongProperties.module.css'

type Section = 'overview' | 'sources' | 'tags' | 'history'

const when = (ms: number | null): string =>
  ms === null || ms === 0 ? 'never' : new Date(ms).toLocaleString()

const bytes = (n: number | null): string => {
  if (n === null) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let u = 0
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++ }
  return `${v.toFixed(u === 0 ? 0 : 1)} ${units[u]}`
}

const mmss = (ms: number | null): string => {
  if (ms === null) return '—'
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** Plain language for how this track came to be one track. */
const identityExplanation = (source: string): string => ({
  manual: 'Merged or split by hand. Automated passes leave it alone.',
  mbid: 'Identified by its MusicBrainz recording id.',
  acoustid: 'Identified by an acoustic fingerprint.',
  audio_hash: 'Identified by matching audio content.',
  heuristic: 'Grouped by its path and tags; no stronger evidence was available.'
} as Record<string, string>)[source] ?? source

const hashExplanation = (algo: string | null): string => ({
  'flac-streaminfo-md5': "FLAC's own checksum of the decoded audio. Exact, and free to read.",
  'sha256-mdat': 'Hashed over the MP4 audio data with the tag atoms excluded, so retagging does not change it.',
  'sha256-ogg-packets': 'Hashed over the Ogg audio packets with the comment header excluded, so retagging does not change it.',
  'sha256-frames': 'Hashed over the audio frames with tag regions excluded, so retagging does not change it.',
  'sha256-file': 'Hashed over the whole file, so editing tags will change it. Weaker for move detection.'
} as Record<string, string>)[algo ?? ''] ?? 'Not hashed yet; scan this folder to enable move detection.'

export function SongProperties({ trackId, onclose }: { trackId: number; onclose?: () => void }) {
  const [details, setDetails] = useState<TrackDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [section, setSection] = useState<Section>('overview')

  useEffect(() => {
    void (async () => {
      try {
        const found = await ipc('tracks:details', trackId)
        setDetails(found)
        if (!found) setError('This track no longer exists.')
      } catch (err) {
        setError((err as Error).message)
      }
    })()
  }, [])

  const totalPlays = details?.history.filter((h) => h.kind === 'play').length ?? 0
  const totalSkips = details?.history.filter((h) => h.kind === 'skip').length ?? 0

  const sections: { id: Section; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'sources', label: `Sources (${details?.media.length ?? 0})` },
    { id: 'tags', label: 'Raw tags' },
    { id: 'history', label: 'History' }
  ]

  const nav = sections.map((x) => (
    <button key={x.id} class={section === x.id ? 'active' : undefined} onClick={() => setSection(x.id)}>
      {x.label}
    </button>
  ))

  let body
  if (error) {
    body = <p class={cx(s.note, s.err)}>{error}</p>
  } else if (!details) {
    body = <p class={s.note}>Loading…</p>
  } else if (section === 'overview') {
    body = (
      <section class={s.section}>
        <div class={s.hero}>
          <Cover trackId={details.id} size={160} />
          <div>
            <h2 class={cx(s.h2, s.first)}>Metadata</h2>
            <dl class={s.dl}>
              {details.fields.slice(0, 4).map((f) =>
                f.value !== null && (
                  <Fragment key={f.field}>
                    <dt class={s.dt}>{f.name}</dt>
                    <dd class={s.dd}>{f.field === 'length' ? mmss(Number(f.value)) : f.value}</dd>
                  </Fragment>
                )
              )}
            </dl>
          </div>
        </div>

        <h2 class={s.h2}>All metadata</h2>
        <dl class={s.dl}>
          {details.fields.map((f) =>
            f.value !== null && (
              <Fragment key={f.field}>
                <dt class={s.dt}>{f.name}{f.multi && <span class={s.multi}>set</span>}</dt>
                <dd class={s.dd}>{f.field === 'length' ? mmss(Number(f.value)) : f.value}</dd>
              </Fragment>
            )
          )}
        </dl>

        <h2 class={s.h2}>Identity</h2>
        <p class={s.hint}>{identityExplanation(details.identity.source)}</p>
        <dl class={s.dl}>
          <dt class={s.dt}>Decided by</dt><dd class={s.dd}><code class={s.code}>{details.identity.source}</code></dd>
          <dt class={s.dt}>Pinned</dt>
          <dd class={s.dd}>{details.identity.pinned ? 'Yes — a person decided this' : 'No'}</dd>
          {details.identity.mbRecordingId && (
            <>
              <dt class={s.dt}>MusicBrainz</dt><dd class={s.dd}><code class={s.code}>{details.identity.mbRecordingId}</code></dd>
            </>
          )}
          {details.identity.acoustid && (
            <>
              <dt class={s.dt}>AcoustID</dt><dd class={s.dd}><code class={s.code}>{details.identity.acoustid}</code></dd>
            </>
          )}
          {details.identity.key && (
            <>
              <dt class={s.dt}>Match key</dt><dd class={s.dd}><code class={cx(s.code, s.key)}>{details.identity.key}</code></dd>
            </>
          )}
        </dl>

        <h2 class={s.h2}>Statistics</h2>
        <p class={s.hint}>These belong to the track, not to any one file, so they survive a re-rip.</p>
        <dl class={s.dl}>
          <dt class={s.dt}>Rating</dt>
          <dd class={s.dd}><Stars value={details.statistics.rating} /></dd>
          <dt class={s.dt}>Plays</dt><dd class={s.dd}>{details.statistics.playCount}</dd>
          <dt class={s.dt}>Skips</dt><dd class={s.dd}>{details.statistics.skipCount}</dd>
          <dt class={s.dt}>First played</dt><dd class={s.dd}>{when(details.statistics.firstPlayed)}</dd>
          <dt class={s.dt}>Last played</dt><dd class={s.dd}>{when(details.statistics.lastPlayed)}</dd>
          <dt class={s.dt}>Added</dt><dd class={s.dd}>{when(details.statistics.added)}</dd>
        </dl>

        {(details.loudness.rgTrackGain !== null || details.loudness.rgAlbumGain !== null) && (
          <>
            <h2 class={s.h2}>Loudness</h2>
            <dl class={s.dl}>
              <dt class={s.dt}>Track gain</dt><dd class={s.dd}>{details.loudness.rgTrackGain ?? '—'} dB</dd>
              <dt class={s.dt}>Album gain</dt><dd class={s.dd}>{details.loudness.rgAlbumGain ?? '—'} dB</dd>
            </dl>
          </>
        )}

        {details.merges.length > 0 && (
          <>
            <h2 class={s.h2}>Merge history</h2>
            {details.merges.map((m) => (
              <p key={m.batchId} class={s.hint}>
                Absorbed {m.absorbed} track{m.absorbed === 1 ? '' : 's'} on {when(m.at)}
                {' '}— <code class={s.code}>{m.batchId}</code>
              </p>
            ))}
          </>
        )}
      </section>
    )
  } else if (section === 'sources') {
    body = (
      <section class={s.section}>
        <h2 class={s.h2}>Sources</h2>
        <p class={s.hint}>
          Every file or stream backing this track. The preferred one is what plays; the rest are kept
          so nothing is lost when formats or drives change.
        </p>

        {details.media.length === 0 ? (
          <p class={s.note}>
            No sources. The track and its statistics are kept; add the files back and a scan will
            reattach them.
          </p>
        ) : details.media.map((m) => (
          <article key={m.id} class={cx(s.source, !m.present && s.missing)}>
            <header class={s.header}>
              {m.preferred && <span class={cx(s.tag, s.pref)}>plays</span>}
              {!m.present && <span class={cx(s.tag, s.gone)}>missing</span>}
              <span class={s.codec}>{(m.codec ?? m.kind).toUpperCase()}</span>
              <span class={s.path} title={m.uri}>{m.uri}</span>
              <button class={s.reveal} onClick={() => ipc('tracks:reveal', m.uri)} disabled={!m.present}>
                Show in folder
              </button>
            </header>

            <dl class={cx(s.dl, s.tech)}>
              <dt class={s.dt}>Bitrate</dt><dd class={s.dd}>{m.bitrate ? `${m.bitrate} kbps` : '—'}{m.bitrateMode ? ` ${m.bitrateMode}` : ''}</dd>
              <dt class={s.dt}>Sample rate</dt><dd class={s.dd}>{m.samplerate ? `${m.samplerate} Hz` : '—'}</dd>
              <dt class={s.dt}>Channels</dt><dd class={s.dd}>{m.channels ?? '—'}</dd>
              <dt class={s.dt}>Bit depth</dt><dd class={s.dd}>{m.bitsPerSample ?? '—'}</dd>
              <dt class={s.dt}>Size</dt><dd class={s.dd}>{bytes(m.filesize)}</dd>
              <dt class={s.dt}>Modified</dt><dd class={s.dd}>{when(m.mtime)}</dd>
              <dt class={s.dt}>Last seen</dt><dd class={s.dd}>{when(m.lastSeen)}</dd>
              <dt class={s.dt}>Quality rank</dt><dd class={s.dd}>{m.qualityRank}</dd>
              {(m.startMs !== null || m.endMs !== null) && (
                <>
                  <dt class={s.dt}>Range</dt>
                  <dd class={s.dd}>{mmss(m.startMs)} – {mmss(m.endMs)} (index {m.subtrackIndex})</dd>
                </>
              )}
            </dl>

            <div class={s.hash}>
              <span class={s.hlabel}>Audio hash</span>
              <code class={s.code}>{m.audioHashHex ? `${m.audioHashHex.slice(0, 32)}…` : 'none'}</code>
              <span class={s.halgo}>{m.audioHashAlgo ?? ''}</span>
              <p class={s.hint}>{hashExplanation(m.audioHashAlgo)}</p>
            </div>
          </article>
        ))}
      </section>
    )
  } else if (section === 'tags') {
    body = (
      <section class={s.section}>
        <h2 class={s.h2}>Raw tags, per source</h2>
        <p class={s.hint}>
          What each file actually carries. Two files backing one track can disagree, and X-Music stores
          both rather than losing the disagreement.
        </p>

        {details.media.map((m) => (
          <article key={m.id} class={s.source}>
            <header class={s.header}><span class={s.path} title={m.uri}>{m.uri}</span></header>
            {m.tags.length ? (
              <dl class={s.dl}>
                {m.tags.map((t, i) => (
                  <Fragment key={`${t.field}-${i}`}>
                    <dt class={s.dt}>{t.field}</dt><dd class={s.dd}>{t.value}</dd>
                  </Fragment>
                ))}
              </dl>
            ) : (
              <p class={s.note}>
                No raw tags stored. The gmusicbrowser import records values on the track rather than
                per file; a scan fills these in.
              </p>
            )}
          </article>
        ))}
      </section>
    )
  } else {
    body = (
      <section class={s.section}>
        <h2 class={s.h2}>Play history</h2>
        <p class={s.hint}>
          {details.historyTotal} recorded event{details.historyTotal === 1 ? '' : 's'}
          {details.historyTotal > details.history.length && (
            <> — showing the most recent {details.history.length}</>
          )}
          {' '}· {totalPlays} played, {totalSkips} skipped
        </p>

        {details.history.length ? (
          <ul class={s.history}>
            {details.history.map((h, i) => (
              <li key={`${h.at}-${i}`} class={s.entry}>
                <span class={cx(s.kind, s[h.kind])}>{h.kind}</span>
                <span>{when(h.at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p class={s.note}>Never played.</p>
        )}
      </section>
    )
  }

  return (
    <Page
      title={details?.title ?? 'Track'}
      subtitle={details
        ? `${details.media.length} source${details.media.length === 1 ? '' : 's'} · ` +
          `${details.statistics.playCount} play${details.statistics.playCount === 1 ? '' : 's'}`
        : undefined}
      onclose={onclose}
      nav={nav}
    >
      {body}
    </Page>
  )
}
