# Issues

Known defects and gaps, most severe first. Strike an item through when it is fixed and
note the commit; don't delete it. Features and ideas live in TODO.md, not here.

## Open

- **High** — The renderer holds at most 1,500 messages per account (`WINDOW_PER_ACCOUNT`).
  Older inbox mail disappears from lists and search, threads can render incomplete, and
  thread actions only touch loaded messages. Fix: thread-level queries, actions, and FTS
  search in main over SQLite; renderer becomes a view. `src/renderer/src/store.ts`,
  `src/main/db.ts`.
- **Medium** — Backfill fetches every message in full (`format=full`), so a mailbox is
  ~1 GB on disk and the first sync takes a long time. Planned: metadata-only index for
  every message, bodies fetched on open and cached. `src/main/sync.ts`.
- **Medium** — The v1→v2 schema migration runs synchronously in `initDb` before any window
  is shown; on a 1 GB database that is ~15 s of apparent hang. `src/main/db.ts`.
- **Medium** — Attachments are skipped entirely; a message with only an attachment looks
  empty. Needs part metadata + on-demand download. `src/main/google/gmail.ts`.
- **Medium** — `pnpm lint` fails on main with 19 pre-existing errors: `require()` in
  `scripts/ensure-electron.js`, and react-hooks rules in `ComposerModal.tsx`,
  `ReplyComposer.tsx`, `RichEditor.tsx`, `SearchOverlay.tsx`.
- **Low** — The v2 migration's table rebuild left ~1.1 GB of free pages: `mail.db` is 2.2 GB
  on disk for 1.1 GB of live data. Run `VACUUM` after migrations (or enable
  `auto_vacuum=INCREMENTAL` before the first one). `src/main/db.ts`.
- **Low** — Full resync after history expiry fetches at most 2,000 newest missing messages
  (`RESYNC_NEW_CAP`); a longer gap leaves holes until the next pass. `src/main/sync.ts`.
- **Low** — Delta sync polls every 60 s regardless of window focus. Shorten when focused,
  back off when not. `src/main/sync.ts`.
- **Low** — `hasOwnReply` counts draft replies as answering the parent, while
  `cancelSend(asDraft)` un-answers it. Pick one. `src/main/db.ts`, `src/main/outbox.ts`.
- **Low** — The IPC sender check's rejection paths (foreign frame / other origin) are
  verified by reading only; nothing in the app can produce such a sender to test against.
  `src/main/validate.ts`.
- **Low** — A sent thread with no recipients shows the user's own name in the list row.
  `src/renderer/src/components/inbox/ThreadRow.tsx`.
- **Low** — The reply composer never shows who it is replying to until sent.
  `src/renderer/src/components/compose/ReplyComposer.tsx`.

## Fixed

- ~~**High** — Failed sends looked sent: messages entered Sent before Gmail confirmed and
  failures only logged.~~ Persisted send lifecycle (queued/sending/sent/failed) with inline
  Retry/Edit. `cf51be0`
- ~~**High** — Drafts disappeared on restart and on add/remove account (`init` cleared
  memory); draft edits/deletes never reached Gmail.~~ Drafts are SQLite rows pushed to Gmail
  Drafts. `cf51be0`
- ~~**High** — Send-later lived in a JavaScript timer and recomputed recipients at fire
  time.~~ Feature removed: reliable scheduling needs a server. `5c2619d`
- ~~**High** — Archive/read/pin/move updated SQLite before Gmail with no rollback or retry;
  offline actions looked successful forever.~~ Persisted ops queue with backoff and a
  Retry/Discard banner. `cf51be0`
- ~~**High** — Expired history advanced the checkpoint and refreshed only 100 recent
  messages.~~ Full reconcile (deletions, label state, newest missing) commits the anchor
  only on success. `cf51be0`
- ~~**High** — Interrupted send could go out twice: recovery reset the op with attempts
  unchanged, so the re-check by Message-ID was skipped.~~ Unverified sends are deferred with
  an attempt counted. `c084582`
- ~~**High** — Full resync deleted a just-sent message when Gmail's listing lagged.~~ Only
  `synced` rows are reconciled. `c084582`
- ~~**Medium** — Electron: sandbox off, any URL scheme passed to `shell.openExternal`, IPC
  payloads and senders unvalidated.~~ `b0611e6`
- ~~**Medium** — Remote images loaded on open (tracking pixels).~~ Blocked by default with a
  per-message Load images control. `8a0571a`
- ~~**Medium** — No test coverage anywhere.~~ vitest suite over migration, upserts, outbox
  state machine, and history-expired reconcile. `832ca3b` `7944f99` `eb1de28`
- ~~**Medium** — Migration dedupe subquery was quadratic (minutes on a 1 GB mailbox).~~
  Indexed the old table first. `dffe8f2`
- ~~**Low** — A queued row adopted by upsert stayed `queued` with a Gmail id and could be
  sent again.~~ Non-draft copies mark the row `synced`. `c084582`
- ~~**Low** — Sending a draft that arrived via sync left the Gmail draft behind.~~ Draft
  delete resolves the draft id from the message id. `c084582`
- ~~**Low** — Discarding a failed send kept it as a local-only draft.~~ Pushed as a draft.
  `c084582`
- ~~**Low** — Ops enqueued by other ops waited for the next 10 s poll.~~ Drain loops until
  nothing is due. `c084582`
- ~~**Low** — Signature was hardcoded; hide-done and word-count toggles reset on restart.~~
  Persisted in the config table. `cf51be0`
