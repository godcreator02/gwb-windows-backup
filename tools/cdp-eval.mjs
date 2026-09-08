// 实机验证用的小探针：连 CDP 的页面 WebSocket，Runtime.evaluate 一段表达式，
// 把 JSON 结果打到 stdout。用法：node tools/cdp-eval.mjs <port> <expression>
const port = process.argv[2]
const expression = process.argv[3]
if (port === undefined || expression === undefined) {
  console.error('用法：node tools/cdp-eval.mjs <port> <expression>')
  process.exit(1)
}
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
const page = targets.find((t) => t.type === 'page')
if (page === undefined) {
  console.error('没有 page 目标')
  process.exit(1)
}
const socket = new WebSocket(page.webSocketDebuggerUrl)
socket.addEventListener('open', () => {
  socket.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }),
  )
})
socket.addEventListener('message', (event) => {
  const reply = JSON.parse(String(event.data))
  if (reply.id !== 1) return
  const result = reply.result?.result
  if (result === undefined) {
    console.error(JSON.stringify(reply.result ?? reply))
  } else {
    console.log(JSON.stringify(result.value ?? result.description ?? result))
  }
  socket.close()
  process.exit(0)
})
setTimeout(() => {
  console.error('CDP 超时')
  process.exit(1)
}, 20_000)
