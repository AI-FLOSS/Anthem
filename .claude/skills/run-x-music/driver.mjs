// Drives a running X-Music window over the Chrome DevTools Protocol.
// X-Music is launched separately with --remote-debugging-port=9222; this attaches to that port.
// Usage: node driver.mjs eval "<js>" | shot <file> | text [selector] | menu <rowIndex>
import { writeFileSync } from 'node:fs'

const PORT = process.env.X_MUSIC_CDP_PORT ?? '9222'
const [mode, ...rest] = process.argv.slice(2)
const arg = rest.join(' ')

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
if (!page) {
  console.error('no page target:', targets.map((t) => `${t.type} ${t.url}`))
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const n = ++id
    pending.set(n, { res, rej })
    ws.send(JSON.stringify({ id: n, method, params }))
  })

ws.onmessage = (m) => {
  const msg = JSON.parse(m.data)
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result)
}

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  return r.result?.value ?? r.result
}

await new Promise((r) => (ws.onopen = r))

switch (mode) {
  case 'shot': {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(arg, Buffer.from(data, 'base64'))
    console.log('wrote', arg)
    break
  }
  case 'text': {
    const sel = arg || 'body'
    console.log(await evaluate(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? '(no match)'`))
    break
  }
  case 'menu': {
    // Opening the context menu and reading it must be two separate calls; see SKILL.md.
    await evaluate(
      `document.querySelectorAll('[role=row]')[${Number(arg) || 0}]` +
        `.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:600,clientY:340,button:2}))`
    )
    console.log('menu opened; read it with: node driver.mjs eval "..."')
    break
  }
  default:
    console.log(JSON.stringify(await evaluate(arg), null, 2))
}

ws.close()
process.exit(0)
