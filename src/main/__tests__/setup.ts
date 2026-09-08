import { vi } from 'vitest'

/**
 * The main process reaches for `electron` in db.ts (app, safeStorage),
 * notify.ts (BrowserWindow) and google/oauth.ts (shell). None of that exists
 * under plain Node, so the module is replaced wholesale. `app.getPath` points
 * at a throwaway directory so nothing can touch the real mailbox store.
 */
const { tmpDir } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('fs')
  const { tmpdir } = await import('os')
  const { join } = await import('path')
  return { tmpDir: mkdtempSync(join(tmpdir(), 'flint-test-')) }
})

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir,
    getName: () => 'flint-test'
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  },
  BrowserWindow: {
    getAllWindows: () => []
  },
  shell: {
    openExternal: async () => undefined
  },
  ipcMain: {
    handle: () => undefined
  }
}))

// The code under test narrates deferrals and failures; keep the run readable.
vi.spyOn(console, 'warn').mockImplementation(() => undefined)
vi.spyOn(console, 'error').mockImplementation(() => undefined)
vi.spyOn(console, 'log').mockImplementation(() => undefined)
