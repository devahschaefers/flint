import { BrowserWindow } from 'electron'

/**
 * "The local store changed" push to every renderer. Sync traffic is throttled
 * (trailing edge) so backfill pages don't spam the UI; user-initiated writes
 * go out immediately so the screen reflects them without a visible lag.
 */

const THROTTLE_MS = 800
let timer: NodeJS.Timeout | null = null

function send(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('mail:changed')
  }
}

export function notifyMailChanged(immediate = false): void {
  if (immediate) {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    send()
    return
  }
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    send()
  }, THROTTLE_MS)
}
