You may launch the app to test your work (`cargo run -p flint`). Test on the demo mailbox
(`FLINT_DB`, see README.md), not the real one, so nothing can send real mail. Always quit it
when you are done: check `pgrep -fl "target/(debug|release)/flint"` and kill anything you
started. The real SQLite database in ~/Library/Application Support/flint is shared by every
worktree and every running instance, so never run two instances at once and never point
tests at it.

Track defects in ISSUES.md: add new ones as you find them, and strike an item through (with
the fixing commit) rather than deleting it when it is fixed. Features and ideas go in TODO.md.
