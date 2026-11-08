# Issues

Known defects and gaps, most severe first. Strike an item through when it is fixed and
note the commit; don't delete it. Features and ideas live in TODO.md, not here.

## Open

- **Medium** — GPUI app: compose is a Markdown text area, not the TipTap rich editor. The
  toolbar and `/` menu write Markdown (`# `, `- `, `**…**`, fences), converted to the
  text/html part on send; there is no live formatting and no selection bubble menu. Drafts
  written by the Electron editor are converted back to Markdown on open (lossy for markup the
  converter doesn't know). `crates/flint/src/views/editor.rs`, `util/mailhtml.rs`.
- ~~**Medium** — GPUI app: mail HTML goes through GPUI Kit's text view, a document renderer,
  not a browser. Layout tables are flattened to blocks, CSS is ignored, and inline `<code>` is
  unwrapped to plain text because the text view (0.9) paints it as a box over the whole
  paragraph. Newsletters read as a single column of text and images.
  `crates/flint/src/util/mailhtml.rs`.~~ Replaced by the Blitz renderer (688df86).
- **Medium** — GPUI app: HTML bodies are painted images (Blitz → pixels), so their text
  can't be selected or copied, links show no pointer cursor or hover state, and there is no
  find-in-message. Hit-testing already works (clicks open links), so selection is the next
  step. `crates/flint/src/views/mailview.rs`, `crates/flint-html`.
- **Low** — GPUI app: unsent reply text is kept per conversation only while the app runs;
  quitting loses it (saving it as a Gmail draft would fix that). Sideways scrolling in wide
  mail is checked with an injected wheel event, since computer use can't send horizontal
  scrolls; a real trackpad hasn't exercised it. `crates/flint/src/views/thread.rs`.
- **Low** — GPUI app: mail that sets a dark text color without its own background reads dark
  on the dark ground (the Electron app had the same problem). Needs a contrast pass, or a
  light page behind such mail. `crates/flint/src/views/mailview.rs`.
- **Low** — GPUI app: Blitz is slow in debug builds (100–300 ms per message, first one
  includes system font loading); `cargo run -p flint --release` is the fast path.
- **Low** — GPUI app: lists render every loaded row (a scrolling div, 50 rows per page
  fetched as you near the bottom) rather than a virtualized list; long scroll sessions grow
  the frame cost. `crates/flint/src/views/list.rs`.
- **Low** — GPUI app: an unsigned dev build changes code signature on every rebuild, so
  macOS asks again for access to the "flint Safe Storage" keychain item after each build.
- **Low** — GPUI app: the CSS spinner, enter/fade transitions and the drag-region cursor are
  not reproduced (a static ring marks in-flight sends). `crates/flint/src/views/widgets.rs`.
- **Medium** — Schema migrations run synchronously in `initDb` before any window is shown:
  the v1→v2 table rebuild was ~15 s on a 1 GB database, and v2→v3 adds the FTS build
  (~1.5 s) plus a one-off `VACUUM` of the whole file. A splash/progress window, or running
  migrations off the main thread, would hide it. `src/main/db.ts`.
- **Medium** — Attachments are skipped entirely; a message with only an attachment looks
  empty. Needs part metadata + on-demand download. `src/main/google/gmail.ts`.
- **Medium** — List queries scale with the mailbox, not the page. Every thread-list page and
  the smart-inbox overview aggregate all messages in scope (GROUP BY, then filter/sort/limit):
  50–100 ms per page on 21k conversations, re-run on every mail change and every scroll page.
  `listContacts` walks every row (40 ms) on each change too. Linear in messages, so ~6 more
  accounts of similar size means 0.4–0.7 s per page and a sluggish "All accounts" view. Fix:
  a maintained `threads` table (and a `contacts` table) updated on message writes, so a page
  is an index range read regardless of size. `src/main/queries.ts`.
- **Low** — Full resync after history expiry fetches at most 2,000 newest missing messages
  (`RESYNC_NEW_CAP`); a longer gap leaves holes until the next pass. It also still fetches
  them with `format=full` rather than metadata-first like backfill. `src/main/sync.ts`.
- **Low** — A build still on schema v2 (any worktree behind main) that opens the shared
  `mail.db` writes `user_version = 2` back and stores new mail as plain TEXT without FTS
  entries; it also reads compacted bodies as raw BLOBs. The next v3 start re-runs the v3
  step (index rebuild over every row, then VACUUM: a few seconds on the 22k mailbox), so
  nothing is lost, but AGENTS.md's one-instance rule matters more now that the schema
  differs across worktrees. `src/main/db.ts`.
- **Low** — `WireMessage` carries no `bodyState`, so the renderer cannot tell an empty body
  from one not fetched yet. Threads fetch on open (`mail:thread` → `ensureBodies`), so the
  gap only shows while a fresh account's phase-2 backfill is still running.
  `src/preload/index.d.ts`, `src/main/db.ts`.
- **Low** — Delta sync polls every 60 s regardless of window focus. Shorten when focused,
  back off when not. `src/main/sync.ts`.
- **Low** — `hasOwnReply` counts draft replies as answering the parent, while
  `cancelSend(asDraft)` un-answers it. Pick one. `src/main/db.ts`, `src/main/outbox.ts`.
- **Low** — The IPC sender check's rejection paths (foreign frame / other origin) are
  verified by reading only; nothing in the app can produce such a sender to test against.
  `src/main/validate.ts`.
- **Low** — The reply composer never shows who it is replying to until sent.
  `src/renderer/src/components/compose/ReplyComposer.tsx`.

## Fixed

- ~~**High** — GPUI app: the composer's text area collapsed to one visible line. `crates/flint/src/views/compose.rs`, `editor.rs`.~~ It fills the card and scrolls itself. `c848f2c`
- ~~**High** — GPUI app: long recipient lists, short windows and high zoom pushed Subject, Send and the footer out of reach in the composer. `crates/flint/src/views/compose.rs`.~~ Chips are capped and scroll; the card scrolls. `c848f2c`
- ~~**Medium** — GPUI app: search's arrow-key selection moved out of view, its advertised ⌘N opened a blank composer behind search, and opening a result over the composer hid the thread. `crates/flint/src/views/search.rs`, `app.rs`.~~ `c848f2c`
- ~~**Low** — GPUI app: New Message ignored the word-count setting. `crates/flint/src/views/compose.rs`.~~ `c848f2c`
- ~~**High** — GPUI app: unsent reply text vanished on leaving a conversation, and Undo Send could put the text in a different conversation's composer. `crates/flint/src/views/thread.rs`.~~ Text is kept per conversation and Undo returns it to its own. `a7c5a9a`
- ~~**High** — GPUI app: fixed-width HTML mail was clipped at the column with no way to reach the rest. `crates/flint/src/views/mailview.rs`, `crates/flint-html`.~~ It paints in full and scrolls sideways. `3831b6d`
- ~~**Medium** — GPUI app: a sideways swipe scrolled every page vertically. `crates/flint/src/views/list.rs`.~~ Pages are restricted to their axis. `b637fb1`
- ~~**Medium** — GPUI app: opening a reply near the bottom of a thread left Send below the window. `crates/flint/src/views/thread.rs`.~~ The card scrolls into view. `a7c5a9a`
- ~~**Medium** — GPUI app: at high zoom the reply toolbar ran over its corner buttons, the footer hint left the card, and the full-screen editor could collapse to nothing. `crates/flint/src/views/editor.rs`, `thread.rs`.~~ The toolbar wraps, the hint truncates, and the editor holds two lines while the card scrolls. `a7c5a9a`, `6631687`
- ~~**Medium** — GPUI app: long CC lists ran past the window, and HTML bodies ignored the page margins at high zoom. `crates/flint/src/views/thread.rs`, `mailview.rs`.~~ `a7c5a9a`, `3831b6d`
- ~~**Low** — GPUI app: the reply card's expand and close buttons sat about 7 px above the formatting toolbar. `crates/flint/src/views/thread.rs`.~~ `a7c5a9a`
- ~~**Medium** — GPUI app: returning from a thread reset the list to the top and to its first page. `crates/flint/src/app.rs`.~~ The list and its scroll handle are kept while a thread or Settings is open. `7b5ae19`
- ~~**Medium** — GPUI app: the header menu, filter and context menu ran off short windows, leaving the lower items unreachable. `crates/flint/src/views/widgets.rs`.~~ Popovers cap at the window height and scroll. `7b5ae19`
- ~~**Medium** — GPUI app: at 250–300% zoom the icon strip overlapped the page. `crates/flint/src/views/list.rs`.~~ The left page margin always clears the strip. `7b5ae19`, `85cf3a3`
- ~~**Low** — GPUI app: at 300% zoom the list header's unread count ran off the window. `crates/flint/src/views/list.rs`.~~ The account chip truncates and keeps its ✕. `85cf3a3`
- ~~**Low** — GPUI app: at 250–300% zoom the outbox banner and toast ran off both window edges, hiding Discard. `crates/flint/src/views/root.rs`.~~ They keep a window margin and truncate their text. `85cf3a3`
- ~~**High** — The renderer holds at most 1,500 messages per account (`WINDOW_PER_ACCOUNT`). Older inbox mail disappears from lists and search, threads can render incomplete, and thread actions only touch loaded messages. Fix: thread-level queries, actions, and FTS search in main over SQLite; renderer becomes a view. `src/renderer/src/store.ts`, `src/main/db.ts`.~~ Every list is a paged SQLite query answered by main (thread aggregates keyed by `thread_key`), actions address whole conversations, threads load complete on open, and search runs on the FTS index. The renderer holds no mail. `ca811c4`
- ~~**Medium** — One bad row empties the whole mailbox: `init` awaits `reloadMail`, and if `wireToMessage` throws on any message (seen 2026-09-08 when the storage-layer branch's compactor left zstd blob bodies in the shared `mail.db`, which this main returns as `Uint8Array` so `toParagraphs` calls `.split` on a buffer) the store stays empty and `subscribeOnce` is never reached, so no later `onMailChanged` recovers it. Make the mapping per-row tolerant and subscribe before the first load. `src/renderer/src/store.ts`, `src/renderer/src/lib/wire.ts`. Any build behind schema v3 shows an empty mailbox against the compacted database for this reason.~~ The renderer no longer hydrates rows up front; each view maps only what it shows, and the change subscription is set before the first load. `ca811c4`
- ~~**Low** — `queryWindow` still returns full bodies for the newest 1,500 messages per account, which now means decompressing them all on every hydration (tens of MB of HTML per call). Goes away with paged thread queries that fetch bodies per thread. `src/main/db.ts`.~~ Lists read no body columns; bodies are decoded only for the thread being viewed. `ca811c4`
- ~~**Low** — A sent thread with no recipients shows the user's own name in the list row. `src/renderer/src/components/inbox/ThreadRow.tsx`.~~ Rows say "To (no recipient)". `ca811c4`
- ~~**Medium** — Backfill fetched every message in full (`format=full`), so a mailbox was
  ~1 GB on disk and the first sync took a long time.~~ Metadata-first backfill: phase 1
  stores headers/labels/snippet for every message, phase 2 fills bodies newest first, and
  opening a thread fetches its missing bodies on the spot. `003d0d7`
- ~~**Medium** — A label action on a message another client deleted got a 404 from Gmail,
  which the outbox parked as failed, blocking the account's FIFO action lane; batchModify
  fails wholesale when any id is missing.~~ On 404 the batch is retried per message and a
  missing message counts as done; sync removes the row. `003d0d7`
- ~~**Medium** — HTML-only mail (no `text/plain` part, or a token one) had an empty
  `bodyText`, so it was invisible to body search and to any plain-text fallback.~~ Text is
  derived from the HTML at parse time; the compactor does the same for rows already
  stored. `003d0d7` `39d47ae`
- ~~**Low** — The v2 migration's table rebuild left ~1.1 GB of free pages: `mail.db` was
  2.2 GB on disk for 1.1 GB of live data.~~ `VACUUM` runs after any migration, with its
  timing logged. `39d47ae`
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
- ~~**Medium** — `pnpm lint` fails on main with 19 pre-existing errors: `require()` in
  `scripts/ensure-electron.js`, and react-hooks rules in `ComposerModal.tsx`,
  `ReplyComposer.tsx`, `RichEditor.tsx`, `SearchOverlay.tsx`.~~ Scripts get plain JS
  rules; render-time ref writes moved to `useLatest`; search/composer panels mount fresh
  on open instead of resetting state in effects. `decb6c0`
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
