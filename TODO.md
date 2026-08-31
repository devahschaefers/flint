# Todo

## 1. Schedule-send rework
Current behavior is bad and gets replaced:
- Picking a "Send later" option must NOT fire/dismiss immediately — it should *arm* a schedule
  while you keep writing (footer Send becomes e.g. "Send · Tomorrow 8:00 AM", with a way to
  clear or change the time). The message only leaves when you actually hit Send.
- Scheduled mail must be visible somewhere (real clients use a Scheduled/Outbox state):
  show it (e.g. in Sent with a clock badge / its own Scheduled section), openable and
  cancelable before it fires. Firing moves it to Sent proper.
- Custom date/time picker option, not just presets.
- Same treatment for the New Message modal, not just replies.

## 2. Sending UI (recipients, cc/bcc, contacts)
- Recipient fields as editable token chips: typing + comma/enter/blur commits a chip,
  backspace edits/removes, invalid input flagged.
- Contact autocomplete dropdown while typing (seed + collected contacts, ranked), keyboard
  navigable.
- Cc and Bcc rows (collapsed behind "Cc Bcc" affordances like real clients); Bcc kept as
  client-side metadata — never rendered as a visible header on the message.
- Reply composer shows/edit its recipients too (currently invisible until sent).

## 3. HTML support
Interpretation to confirm: full HTML *email rendering* — incoming mail with real HTML bodies
(newsletters, GitHub notifications with styled markup, tables, buttons, images) rendered
sanitized and dark-mode-friendly in the thread view, with mock data upgraded to include
genuine HTML messages. (Compose already produces a text/html part via the rich editor.)

## 4. Real-mail follow-ups (post Gmail sync)
Gmail read sync + action writeback landed (SQLite in main, PKCE OAuth, backfill + history
delta). Still open, roughly in order:
- Real sending: gmail.send scope + messages.send / drafts API. Compose/reply currently only
  writes to the local in-memory store when connected (nothing actually leaves the machine);
  local "sent" mail also vanishes on relaunch. Fold the schedule-send rework (#1) into this.
- Draft round-trip: local draft edits/deletes don't push to Gmail (synced drafts reappear).
- Search over the full DB: FTS5 table + IPC search endpoint (renderer search only sees the
  hydrated window — newest 1500/account — today).
- Replace the hydration window with true paged thread queries (infinite scroll from SQLite).
- HTML rendering hardening: remote images are still loaded (tracking pixels!) — block by
  default with a per-sender allow. Also #3's dark-mode treatment. Sanitization (DOMPurify)
  is already in.
- Attachments: parts are skipped entirely; store metadata + on-demand download to disk.
- \Answered flag: Gmail doesn't expose it via labels; derive from own replies in-thread.
- iCloud account support: IMAP adapter (imapflow/mailparser/nodemailer) + app-specific
  password auth behind the same account interface.
