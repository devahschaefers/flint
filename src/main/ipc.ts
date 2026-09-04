import { ipcMain } from 'electron'
import * as db from './db'
import { syncEngine } from './sync'
import type { GoogleConfig, MailAction, SendMailInput } from '../preload/index.d'

export function registerIpc(): void {
  ipcMain.handle('config:google:get', (): GoogleConfig => ({
    clientId: db.getConfig('google_client_id') ?? '',
    clientSecret: db.getConfig('google_client_secret') ?? ''
  }))
  ipcMain.handle('config:google:set', (_e, cfg: GoogleConfig) => {
    db.setConfig('google_client_id', cfg.clientId.trim())
    db.setConfig('google_client_secret', cfg.clientSecret.trim())
  })

  ipcMain.handle('accounts:list', () => db.listAccounts())
  ipcMain.handle('accounts:add', () => syncEngine.addAccount())
  ipcMain.handle('accounts:remove', (_e, id: string) => syncEngine.removeAccount(id))

  ipcMain.handle('mail:window', (_e, perAccount: number) => db.queryWindow(perAccount))
  ipcMain.handle('mail:thread', (_e, p: { accountId: string; threadId: string }) =>
    db.queryThread(p.accountId, p.threadId)
  )
  ipcMain.handle(
    'mail:action',
    (_e, p: { accountId: string; gmailIds: string[]; action: MailAction; value?: boolean }) =>
      syncEngine.applyAction(p.accountId, p.gmailIds, p.action, p.value)
  )

  ipcMain.handle('mail:send', (_e, input: SendMailInput) => syncEngine.sendMail(input))

  ipcMain.handle('sync:refresh', () => syncEngine.deltaAll())
  ipcMain.handle('sync:status', () => syncEngine.status())
}
