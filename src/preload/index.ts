import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { GoogleConfig, MailAction, MailApi, SendMailInput } from './index.d'

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
  sendMail: (input: SendMailInput) => ipcRenderer.invoke('mail:send', input),
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
