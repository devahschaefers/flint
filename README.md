# Flint

A desktop email client. Two builds live here side by side and share one mailbox
(`~/Library/Application Support/flint/mail.db`):

- **GPUI (Rust)**, in `crates/`: `flint-core` is the store, Gmail sync and outbox; `flint`
  is the native UI. This is the build going forward.
- **Electron (React + TypeScript)**, in `src/`: the original.

Never run both at once: the GPUI app refuses to start while the Electron app (or another
copy of itself) is running, since two outbox workers on one database could send twice.

## GPUI build

```bash
cargo run -p flint                 # the app, on your real mailbox
cargo test -p flint-core -p flint  # tests never touch the real mailbox

# Look at the UI on made-up mail instead of yours
python3 crates/flint/dev/seed_demo.py /tmp/flint-demo.db
FLINT_DB=/tmp/flint-demo.db cargo run -p flint

# Debug builds: open a screen at start, and save a frame without screen-recording permission
FLINT_DB=/tmp/flint-demo.db FLINT_OPEN=thread:0 FLINT_SHOT=/tmp/shot.png \
  cargo run -p flint --features screenshots
```

No Xcode needed: Metal shaders compile at runtime.

## Electron build

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ pnpm install
```

### Development

```bash
$ pnpm run dev
```

### Build

```bash
# For windows
$ pnpm run build:win

# For macOS
$ pnpm run build:mac

# For Linux
$ pnpm run build:linux
```
