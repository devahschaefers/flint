import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import * as db from './db'
import { outbox } from './outbox'
import { syncEngine } from './sync'
import type { GoogleConfig } from '../preload/index.d'
import {
  asBoolean,
  asFiniteNumber,
  asGoogleConfig,
  asIdListOrNull,
  asLocalMessageInput,
  asMailAction,
  asObject,
  asOptionalBoolean,
  asString,
  asStringArray,
  assertTrustedSender
} from './validate'

/**
 * `ipcMain.handle` with the sender check applied before the handler sees the
 * payload. Handlers receive the raw argument as `unknown` and must narrow it
 * with the guards in ./validate; a thrown Error rejects the renderer's promise.
 */
function handle(
  channel: string,
  fn: (payload: unknown, event: IpcMainInvokeEvent) => unknown
): void {
  ipcMain.handle(channel, (event, payload: unknown) => {
    assertTrustedSender(event)
    return fn(payload, event)
  })
}

export function registerIpc(): void {
  handle('config:google:get', (): GoogleConfig => ({
    clientId: db.getConfig('google_client_id') ?? '',
    clientSecret: db.getConfig('google_client_secret') ?? ''
  }))
  handle('config:google:set', (raw) => {
    const cfg = asGoogleConfig(raw)
    db.setConfig('google_client_id', cfg.clientId.trim())
    db.setConfig('google_client_secret', cfg.clientSecret.trim())
  })

  handle('accounts:list', () => db.listAccounts())
  handle('accounts:add', () => syncEngine.addAccount())
  handle('accounts:remove', (raw) => syncEngine.removeAccount(asString(raw, 'id')))

  handle('mail:window', (raw) => {
    const perAccount = asFiniteNumber(raw, 'perAccount')
    if (perAccount < 0) throw new Error('perAccount must be non-negative')
    return db.queryWindow(perAccount)
  })
  handle('mail:thread', (raw) => {
    const p = asObject(raw, 'params')
    return db.queryThread(asString(p.accountId, 'accountId'), asString(p.threadId, 'threadId'))
  })
  handle('mail:action', (raw) => {
    const p = asObject(raw, 'params')
    return outbox.applyAction(
      asString(p.accountId, 'accountId'),
      asStringArray(p.gmailIds, 'gmailIds'),
      asMailAction(p.action, 'action'),
      asOptionalBoolean(p.value, 'value')
    )
  })

  handle('mail:draft:save', (raw) => outbox.saveDraft(asLocalMessageInput(raw)))
  handle('mail:local:delete', (raw) => {
    const p = asObject(raw, 'params')
    return outbox.deleteLocal(
      asString(p.accountId, 'accountId'),
      asString(p.messageIdHdr, 'messageIdHdr')
    )
  })
  handle('mail:send:queue', (raw) => {
    const p = asObject(raw, 'params')
    return outbox.queueSend(
      asLocalMessageInput(p.input, 'input'),
      asFiniteNumber(p.sendAfterMs, 'sendAfterMs')
    )
  })
  handle('mail:send:cancel', (raw) => {
    const p = asObject(raw, 'params')
    return outbox.cancelSend(
      asString(p.accountId, 'accountId'),
      asString(p.messageIdHdr, 'messageIdHdr'),
      asBoolean(p.asDraft, 'asDraft')
    )
  })
  handle('mail:send:retry', (raw) => {
    const p = asObject(raw, 'params')
    return outbox.retrySend(
      asString(p.accountId, 'accountId'),
      asString(p.messageIdHdr, 'messageIdHdr')
    )
  })

  handle('outbox:list', () => outbox.listTroubled())
  handle('outbox:retry', (raw) => outbox.retry(asIdListOrNull(raw, 'ids')))
  handle('outbox:discard', (raw) => outbox.discard(asIdListOrNull(raw, 'ids')))

  handle('settings:get', () => db.getSettings())
  handle('settings:set', (raw) => {
    const p = asObject(raw, 'params')
    return db.setSetting(asString(p.key, 'key'), asString(p.value, 'value'))
  })

  handle('sync:refresh', () => syncEngine.deltaAll())
  handle('sync:status', () => syncEngine.status())
}
