import type { XMusicApi, XMusicEvents, Channel, EventName } from '../shared/ipc'

declare global {
  interface Window {
    xMusic: { [C in Channel]: (...args: Parameters<XMusicApi[C]>) => Promise<ReturnType<XMusicApi[C]>> }
    xMusicEvents: {
      on<E extends EventName>(name: E, handler: (payload: XMusicEvents[E]) => void): () => void
    }
  }
}

export {}
