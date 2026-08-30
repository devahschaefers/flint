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
