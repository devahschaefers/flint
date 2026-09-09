import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { initDb } from './db'
import { registerIpc } from './ipc'
import { outbox } from './outbox'
import { compactor } from './storage/compactor'
import { syncEngine } from './sync'

if (is.dev) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env['DEBUG_PORT'] ?? '9223')
}

/**
 * Only web links and mailto: reach the OS. Mail HTML is attacker-controlled
 * and `shell.openExternal` will happily launch `file:`, `smb:`, or any
 * registered custom scheme, so anything else is dropped and logged.
 */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

function openExternalSafely(url: string): void {
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    console.warn(`[nav] dropped unparseable URL: ${url}`)
    return
  }
  if (!EXTERNAL_PROTOCOLS.has(protocol)) {
    console.warn(`[nav] dropped ${protocol} URL: ${url}`)
    return
  }
  void shell.openExternal(url).catch((err) => console.warn(`[nav] openExternal failed:`, err))
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    // The lights sit in the window's top-left margin, above the icon strip
    trafficLightPosition: { x: 20, y: 18 },
    backgroundColor: '#151515',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The renderer only ever talks to main through the contextBridge API, so
      // it runs in the Chromium sandbox with no Node access at all.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    openExternalSafely(details.url)
    return { action: 'deny' }
  })

  // Real email HTML contains links; clicks must open the system browser, never
  // navigate the app window
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (is.dev && devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
    openExternalSafely(url)
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  initDb()
  registerIpc()
  syncEngine.startScheduler()
  outbox.start()
  // Compresses pre-v3 bodies in the background; a no-op once they are all done
  compactor.start()

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
