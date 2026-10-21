// Renderer-side entry point for every IPC call.
//
// contextBridge clones arguments as they cross from the page's world into the preload's isolated
// world, and that clone happens *before* any preload code runs. So an uncloneable value, such as a
// Proxy, has to be flattened here, in the renderer, or the call fails with "An object could not be
// cloned" no matter what the preload does. Calling window.xMusic directly is a bug waiting to happen; call
// this instead.

import { toCloneable, type XMusicApi, type Channel } from '@shared/ipc'

export function ipc<C extends Channel>(
  channel: C,
  ...args: Parameters<XMusicApi[C]>
): Promise<ReturnType<XMusicApi[C]>> {
  const plain = args.map(toCloneable) as Parameters<XMusicApi[C]>
  return window.xMusic[channel](...plain)
}
