# Flint

A native desktop email client for Gmail, written in Rust with
[GPUI](https://www.gpui.rs/). Your mail lives in a local SQLite database at
`~/Library/Application Support/flint/mail.db`.

- `crates/flint-core`: the mail store, Gmail sync, and the outbox
- `crates/flint`: the UI
- `crates/flint-html`: renders HTML mail with Blitz

Only one copy runs at a time, since two outbox workers on one database could send twice.

## Development

```bash
cargo run -p flint --release                     # the app, on your real mailbox (debug builds render mail slowly)
cargo test -p flint-core -p flint-html -p flint  # tests never touch the real mailbox

# Look at the UI on made-up mail instead of yours
python3 crates/flint/dev/seed_demo.py /tmp/flint-demo.db
FLINT_DB=/tmp/flint-demo.db cargo run -p flint

# Debug builds: open a screen at start, and save a frame without screen-recording permission
FLINT_DB=/tmp/flint-demo.db FLINT_OPEN=thread:0 FLINT_SHOT=/tmp/shot.png \
  cargo run -p flint --features screenshots
```

No Xcode needed: Metal shaders compile at runtime.
