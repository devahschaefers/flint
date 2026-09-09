import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  GoogleConfig,
  LocalMessageInput,
  MailApi,
  ThreadAction,
  ThreadQuery,
  ThreadRef
} from './index.d'

const api: MailApi = {
  getGoogleConfig: () => ipcRenderer.invoke('config:google:get'),
  setGoogleConfig: (cfg: GoogleConfig) => ipcRenderer.invoke('config:google:set', cfg),
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  addAccount: () => ipcRenderer.invoke('accounts:add'),
  removeAccount: (id: string) => ipcRenderer.invoke('accounts:remove', id),

  listThreads: (query: ThreadQuery) => ipcRenderer.invoke('threads:list', query),
  inboxOverview: (accountId: string | null, includeArchived: boolean) =>
    ipcRenderer.invoke('threads:overview', { accountId, includeArchived }),
  getThread: (ref: ThreadRef) => ipcRenderer.invoke('threads:get', ref),
  search: (query: string, accountId: string | null, limit: number) =>
    ipcRenderer.invoke('threads:search', { query, accountId, limit }),
  listDrafts: (accountId: string | null) => ipcRenderer.invoke('mail:drafts', { accountId }),
  listContacts: (accountId: string | null) => ipcRenderer.invoke('mail:contacts', { accountId }),
  unreadCounts: () => ipcRenderer.invoke('mail:unread'),
  getMessage: (accountId: string, messageIdHdr: string) =>
    ipcRenderer.invoke('mail:message', { accountId, messageIdHdr }),

  threadAction: (refs: ThreadRef[], action: ThreadAction) =>
    ipcRenderer.invoke('threads:action', { refs, action }),
  saveDraft: (input: LocalMessageInput) => ipcRenderer.invoke('mail:draft:save', input),
  deleteLocalMessage: (accountId: string, messageIdHdr: string) =>
    ipcRenderer.invoke('mail:local:delete', { accountId, messageIdHdr }),
  queueSend: (input: LocalMessageInput, sendAfterMs: number) =>
    ipcRenderer.invoke('mail:send:queue', { input, sendAfterMs }),
  cancelSend: (accountId: string, messageIdHdr: string, asDraft: boolean) =>
    ipcRenderer.invoke('mail:send:cancel', { accountId, messageIdHdr, asDraft }),
  retrySend: (accountId: string, messageIdHdr: string) =>
    ipcRenderer.invoke('mail:send:retry', { accountId, messageIdHdr }),

  listOutbox: () => ipcRenderer.invoke('outbox:list'),
  retryOutbox: (ids?: number[]) => ipcRenderer.invoke('outbox:retry', ids ?? null),
  discardOutbox: (ids?: number[]) => ipcRenderer.invoke('outbox:discard', ids ?? null),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key: string, value: string) => ipcRenderer.invoke('settings:set', { key, value }),

  refresh: () => ipcRenderer.invoke('sync:refresh'),
  syncStatus: () => ipcRenderer.invoke('sync:status'),
  onMailChanged: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('mail:changed', listener)
    return () => ipcRenderer.removeListener('mail:changed', listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
