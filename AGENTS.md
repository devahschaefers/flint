You may launch the dev server or the app to test your work (`npm run dev`; it exposes Chrome
DevTools Protocol on port 9223, override with `DEBUG_PORT`). Always quit it when you are done:
check `pgrep -fl "electron/dist/Electron.app"` and kill anything you started. The app's SQLite
database in ~/Library/Application Support/flint is shared by every worktree and every running
instance, so never run two instances at once and never point tests at it.

Track defects in ISSUES.md: add new ones as you find them, and strike an item through (with
the fixing commit) rather than deleting it when it is fixed. Features and ideas go in TODO.md.
