import type { Logger } from './log.js'
import { runProcess, TOAST_TIMEOUT_MS } from './process.js'
import type { RunProcess } from './process.js'

/** Windows PowerShell 的 AUMID——借它的身份弹通知，省了自己注册一个应用标识。 */
export const POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/**
 * XML 转义，连 `'` 与 `"` 一起转：转出来的 XML 要放进 PowerShell 的单引号字面串，`'` 会截断那个串。
 * `&` 必须第一个换，否则后面换出来的 `&lt;` 会被二次处理。
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;')
}

/** toast 的 XML 载荷；调用方给的 title / body 在这里统一转义。 */
export function buildToastXml(title: string, body: string): string {
  return (
    '<toast><visual><binding template="ToastGeneric">' +
    `<text>${escapeXml(title)}</text><text>${escapeXml(body)}</text>` +
    '</binding></visual></toast>'
  )
}

/** 拼那条 PowerShell 命令：三个 WinRT 类型加载 + LoadXml + Show。 */
export function buildToastCommand(toastXml: string): string {
  return (
    '[Windows.UI.Notifications.ToastNotificationManager, ' +
    'Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null; ' +
    '[Windows.UI.Notifications.ToastNotification, ' +
    'Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null; ' +
    '[Windows.Data.Xml.Dom.XmlDocument, ' +
    'Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null; ' +
    `$aumid = '${POWERSHELL_AUMID}'; ` +
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument; ' +
    `$xml.LoadXml('${toastXml}'); ` +
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml); ' +
    '[Windows.UI.Notifications.ToastNotificationManager]' +
    '::CreateToastNotifier($aumid).Show($toast)'
  )
}

/**
 * 弹一条 toast。失败只记一行日志、不抛——通知弹不出来不影响已经跑完的备份结论。
 * 用的是 `powershell`（Windows PowerShell 5.1，任何 Windows 都有），不是 `pwsh`。
 */
export async function sendToast(title: string, body: string, logger: Logger, run: RunProcess = runProcess): Promise<boolean> {
  const command = buildToastCommand(buildToastXml(title, body))
  const result = await run('powershell', ['-NoProfile', '-Command', command], { timeoutMs: TOAST_TIMEOUT_MS })
  if (result.code !== 0) {
    const reason = result.timedOut ? 'PowerShell 超时' : result.stderr.trim() || `退出码 ${String(result.code)}`
    logger.line(`Notification failed: ${reason}`)
    return false
  }
  return true
}
