import { contextBridge, ipcRenderer } from 'electron'
import {
  CHANNELS, EVENT_CHANNEL, toCloneable, type XMusicApi, type XMusicEvents, type Channel, type EventName
} from '@shared/ipc'

// The renderer gets exactly the channels declared in the contract, and nothing else.
const api = Object.fromEntries(
  CHANNELS.map((c) => [c, (...args: unknown[]) => ipcRenderer.invoke(c, ...args.map(toCloneable))])
) as { [C in Channel]: (...args: Parameters<XMusicApi[C]>) => Promise<ReturnType<XMusicApi[C]>> }

contextBridge.exposeInMainWorld('xMusic', api)

// One event channel, dispatched by name in the renderer, so the bridge surface stays small.
contextBridge.exposeInMainWorld('xMusicEvents', {
  on<E extends EventName>(name: E, handler: (payload: XMusicEvents[E]) => void): () => void {
    const listener = (_e: unknown, evt: { name: EventName; payload: unknown }): void => {
      if (evt.name === name) handler(evt.payload as XMusicEvents[E])
    }
    ipcRenderer.on(EVENT_CHANNEL, listener)
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, listener)
  }
})
