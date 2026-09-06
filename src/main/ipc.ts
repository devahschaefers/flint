import { ipcMain } from 'electron'
import * as db from './db'
import { outbox } from './outbox'
import { syncEngine } from './sync'
import type { GoogleConfig, LocalMessageInput, MailAction } from '../preload/index.d'

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
      outbox.applyAction(p.accountId, p.gmailIds, p.action, p.value)
  )

  ipcMain.handle('mail:draft:save', (_e, input: LocalMessageInput) => outbox.saveDraft(input))
  ipcMain.handle('mail:local:delete', (_e, p: { accountId: string; messageIdHdr: string }) =>
    outbox.deleteLocal(p.accountId, p.messageIdHdr)
  )
  ipcMain.handle('mail:send:queue', (_e, p: { input: LocalMessageInput; sendAfterMs: number }) =>
    outbox.queueSend(p.input, p.sendAfterMs)
  )
  ipcMain.handle(
    'mail:send:cancel',
    (_e, p: { accountId: string; messageIdHdr: string; asDraft: boolean }) =>
      outbox.cancelSend(p.accountId, p.messageIdHdr, p.asDraft)
  )
  ipcMain.handle('mail:send:retry', (_e, p: { accountId: string; messageIdHdr: string }) =>
    outbox.retrySend(p.accountId, p.messageIdHdr)
  )

  ipcMain.handle('outbox:list', () => outbox.listTroubled())
  ipcMain.handle('outbox:retry', (_e, ids: number[] | null) => outbox.retry(ids))
  ipcMain.handle('outbox:discard', (_e, ids: number[] | null) => outbox.discard(ids))

  ipcMain.handle('settings:get', () => db.getSettings())
  ipcMain.handle('settings:set', (_e, p: { key: string; value: string }) =>
    db.setSetting(p.key, p.value)
  )

  ipcMain.handle('sync:refresh', () => syncEngine.deltaAll())
  ipcMain.handle('sync:status', () => syncEngine.status())
}
