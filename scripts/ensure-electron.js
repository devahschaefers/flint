/**
 * Self-heal the Electron binary install.
 *
 * The `electron` package's own postinstall downloads a platform zip and
 * extracts Electron.app into node_modules/electron/dist, then writes path.txt.
 * On this machine the extraction can fail silently (dist ends up with only
 * LICENSES.chromium.html and no path.txt), which makes electron-vite throw
 * "Error: Electron uninstall". This script detects that state and re-extracts
 * from the download cache.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron')
const distDir = path.join(electronDir, 'dist')
const pathTxt = path.join(electronDir, 'path.txt')

function isHealthy() {
  if (!fs.existsSync(pathTxt)) return false
  const binary = path.join(distDir, fs.readFileSync(pathTxt, 'utf8').trim())
  return fs.existsSync(binary)
}

function findCachedZip(version) {
  const cacheRoots = {
    darwin: path.join(os.homedir(), 'Library', 'Caches', 'electron'),
    linux: path.join(os.homedir(), '.cache', 'electron'),
    win32: path.join(os.homedir(), 'AppData', 'Local', 'electron', 'Cache')
  }
  const root = cacheRoots[process.platform]
  if (!root || !fs.existsSync(root)) return null
  const wanted = `electron-v${version}-${process.platform}-${process.arch}.zip`
  for (const entry of fs.readdirSync(root)) {
    const candidate = path.join(root, entry, wanted)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function main() {
  if (!fs.existsSync(electronDir)) return // electron not installed at all; nothing to heal
  if (isHealthy()) return

  console.log('[ensure-electron] Electron binary missing; repairing...')

  // First give electron's own installer a chance (it may just not have run)
  try {
    execFileSync(process.execPath, [path.join(electronDir, 'install.js')], { stdio: 'inherit' })
  } catch {
    // fall through to manual extraction
  }
  if (isHealthy()) {
    console.log('[ensure-electron] Repaired via electron install.js')
    return
  }

  const version = JSON.parse(
    fs.readFileSync(path.join(electronDir, 'package.json'), 'utf8')
  ).version
  const zip = findCachedZip(version)
  if (!zip) {
    console.error(
      `[ensure-electron] No cached electron-v${version} zip found and install.js did not ` +
        'produce a binary. Run "npx electron --version" once with network access, then reinstall.'
    )
    process.exit(1)
  }

  fs.rmSync(distDir, { recursive: true, force: true })
  fs.mkdirSync(distDir, { recursive: true })
  if (process.platform === 'win32') {
    execFileSync('tar', ['-xf', zip, '-C', distDir], { stdio: 'inherit' })
  } else {
    // unzip preserves the .app bundle's symlinks and exec bits
    execFileSync('unzip', ['-q', zip, '-d', distDir], { stdio: 'inherit' })
  }
  const binaryRelative =
    process.platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : process.platform === 'win32'
        ? 'electron.exe'
        : 'electron'
  fs.writeFileSync(pathTxt, binaryRelative)

  if (!isHealthy()) {
    console.error('[ensure-electron] Extraction completed but the binary is still missing.')
    process.exit(1)
  }
  console.log(`[ensure-electron] Repaired from cache: ${zip}`)
}

main()
