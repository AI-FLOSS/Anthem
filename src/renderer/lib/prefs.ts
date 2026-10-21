// Reactive wrapper over shared/prefs. The logic lives there; this only ties it to the UI framework,
// so remembering a setting is one line at the call site.

import { signal } from '@preact/signals'
import { useMemo } from 'preact/hooks'
import { readPref, writePref, type Validator } from '@shared/prefs'

const storage = (): Storage | undefined =>
  typeof localStorage === 'undefined' ? undefined : localStorage

export interface Pref<T> {
  value: T
}

export function pref<T>(key: string, initial: T, validate?: Validator<T>): Pref<T> {
  const full = `x-music.pref.${key}`
  const current = signal(readPref(storage(), full, initial, validate))

  return {
    get value(): T {
      return current.value
    },
    set value(next: T) {
      current.value = next
      writePref(storage(), full, next)
    }
  }
}

/** A pref owned by one component, read once when it mounts. */
export function usePref<T>(key: string, initial: T, validate?: Validator<T>): Pref<T> {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => pref(key, initial, validate), [])
}
