# Todo

## 1. Sending UI (recipients, cc/bcc, contacts)
- Recipient fields as editable token chips: typing + comma/enter/blur commits a chip,
  backspace edits/removes, invalid input flagged.
- Contact autocomplete dropdown while typing (seed + collected contacts, ranked), keyboard
  navigable.
- Cc and Bcc rows (collapsed behind "Cc Bcc" affordances like real clients); Bcc kept as
  client-side metadata — never rendered as a visible header on the message.
- Reply composer shows/edit its recipients too (currently invisible until sent).

## 2. HTML support
Interpretation to confirm: full HTML *email rendering* — incoming mail with real HTML bodies
(newsletters, GitHub notifications with styled markup, tables, buttons, images) rendered
sanitized and dark-mode-friendly in the thread view, with mock data upgraded to include
genuine HTML messages. (Compose already produces a text/html part via the rich editor.)

## 3. Real-mail follow-ups (post Gmail sync)
Gmail read sync + action writeback landed (SQLite in main, PKCE OAuth, backfill + history
delta). Still open, roughly in order:
- Send-later was removed on purpose: reliable scheduling needs a server to hold and send
  the message; a local timer only fires while the app is running.
- Search over the full DB: the FTS5 index and `db.searchMessages` (bm25 relevance, safe
  query builder) are in main; still to do: the IPC search endpoint and the renderer switch
  (renderer search only sees the hydrated window — newest 1500/account — today).
- Replace the hydration window with true paged thread queries (infinite scroll from SQLite).
  Stage 2 of the storage plan; the per-thread body fetch (`ensureBodies`) is already there.
- Body compression: per-message zstd is in (codec column per row, `storage/bodies.ts`,
  background compactor for pre-v3 rows). Still later: a trained zstd dictionary shared across
  messages measured another ~30% off on real mail (256 KB dict: 10.7% of raw vs 14.5%);
  needs a training step and a `zstd-dict:<id>` codec, which the codec/compactor shape
  already leaves room for.
- HTML rendering: per-sender remember for "Load images" (remote images are now blocked by
  default per message). Also #2's dark-mode treatment.
- Attachments: parts are skipped entirely; store metadata + on-demand download to disk.
- \Answered flag: Gmail doesn't expose it via labels; derive from own replies in-thread.
- iCloud account support: IMAP adapter (imapflow/mailparser/nodemailer) + app-specific
  password auth behind the same account interface.
- Phase 2 of the SDK migration: mailparser over format=raw (charsets, encoded-words,
  attachments) and nodemailer MailComposer when sending gets built.
