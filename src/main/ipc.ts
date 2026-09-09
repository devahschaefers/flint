import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import * as db from './db'
import { outbox } from './outbox'
import * as queries from './queries'
import { syncEngine } from './sync'
import type { GoogleConfig } from '../preload/index.d'
import {
  asBoolean,
  asFiniteNumber,
  asGoogleConfig,
  asIdListOrNull,
  asLocalMessageInput,
  asNullableString,
  asObject,
  asString,
  asThreadAction,
  asThreadQuery,
  asThreadRef,
  asThreadRefs,
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

  // ---- reads ----
  handle('threads:list', (raw) => queries.listThreads(asThreadQuery(raw)))
  handle('threads:overview', (raw) => {
    const p = asObject(raw, 'params')
    return queries.inboxOverview(
      asNullableString(p.accountId, 'accountId'),
      asBoolean(p.includeArchived, 'includeArchived')
    )
  })
  handle('threads:get', async (raw) => {
    const ref = asThreadRef(raw, 'ref')
    // Metadata-only rows get their bodies now; offline, the thread shows what it has
    await syncEngine
      .ensureBodies(ref.accountId, ref.threadKey)
      .catch((err) => console.warn('[ipc] body fetch on open failed:', (err as Error).message))
    return db.queryThread(ref.accountId, ref.threadKey)
  })
  handle('threads:search', (raw) => {
    const p = asObject(raw, 'params')
    return queries.searchThreads(
      asString(p.query, 'query'),
      asNullableString(p.accountId, 'accountId'),
      asFiniteNumber(p.limit, 'limit')
    )
  })
  handle('mail:drafts', (raw) => {
    const p = asObject(raw, 'params')
    return db.listDraftMessages(asNullableString(p.accountId, 'accountId'))
  })
  handle('mail:contacts', (raw) => {
    const p = asObject(raw, 'params')
    return queries.listContacts(asNullableString(p.accountId, 'accountId'))
  })
  handle('mail:unread', () => queries.unreadCounts())
  handle('mail:message', (raw) => {
    const p = asObject(raw, 'params')
    return db.getMessageWireByHdr(
      asString(p.accountId, 'accountId'),
      asString(p.messageIdHdr, 'messageIdHdr')
    )
  })

  // ---- writes ----
  handle('threads:action', (raw) => {
    const p = asObject(raw, 'params')
    const refs = asThreadRefs(p.refs, 'refs')
    const action = asThreadAction(p.action, 'action')
    for (const ref of refs) {
      for (const resolved of queries.resolveThreadAction(ref, action)) {
        outbox.applyAction(ref.accountId, resolved.gmailIds, resolved.action, resolved.value)
      }
    }
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
