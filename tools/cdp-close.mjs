// 实机验证用的小探针：试着连 CDP 的 browser 级 WebSocket 调 Browser.close，精确关掉
// 「这一个」实例——机器上常有别的会话的 electron，按 pid 乱杀会误伤。
// 用法：node tools/cdp-close.mjs <port>
//
// 实测这版 Electron 的 browser 级端点不受理 Browser.close（发过去 socket 不断、进程不死），
// 所以关不掉时把监听那个端口的 pid 报出来，供核对命令行后精确 taskkill：
//   powershell: Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" | % CommandLine
//   taskkill /PID <pid> /T /F
import { execFileSync } from 'node:child_process'

const port = process.argv[2]
if (port === undefined) {
  console.error('用法：node tools/cdp-close.mjs <port>')
  process.exit(1)
}

try {
  const info = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json())
  const socket = new WebSocket(info.webSocketDebuggerUrl)
  const done = new Promise((resolve) => {
    socket.addEventListener('close', () => resolve('closed'))
    setTimeout(() => resolve('timeout'), 5000)
  })
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
  })
  const result = await done
  if (result === 'closed') {
    console.log(`[cdp-close] ${port} 上的实例已关`)
    process.exit(0)
  }
} catch {
  // 端口已经不在了——没什么可关
  console.log(`[cdp-close] ${port} 上没有实例`)
  process.exit(0)
}

const netstat = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
const line = netstat.split('\n').find((one) => one.includes(`:${port}`) && one.includes('LISTENING'))
const pid = line?.trim().split(/\s+/).at(-1)
console.error(`[cdp-close] Browser.close 没能关掉它（这版 Electron 不受理），端口 ${port} 的属主 pid 是 ${pid ?? '?'}——核对命令行后 taskkill /PID ${pid ?? '?'} /T /F`)
process.exit(1)
