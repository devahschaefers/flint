import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { GoogleConfig, LocalMessageInput, MailAction, MailApi } from './index.d'

const api: MailApi = {
  getGoogleConfig: () => ipcRenderer.invoke('config:google:get'),
  setGoogleConfig: (cfg: GoogleConfig) => ipcRenderer.invoke('config:google:set', cfg),
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  addAccount: () => ipcRenderer.invoke('accounts:add'),
  removeAccount: (id: string) => ipcRenderer.invoke('accounts:remove', id),
  getMailWindow: (perAccount: number) => ipcRenderer.invoke('mail:window', perAccount),
  getThread: (accountId: string, threadId: string) =>
    ipcRenderer.invoke('mail:thread', { accountId, threadId }),
  mailAction: (p: { accountId: string; gmailIds: string[]; action: MailAction; value?: boolean }) =>
    ipcRenderer.invoke('mail:action', p),

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
