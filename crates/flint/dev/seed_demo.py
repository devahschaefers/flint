#!/usr/bin/env python3
"""
Build a throwaway Flint mail store full of made-up mail, for looking at the
UI without touching a real mailbox:

    python3 crates/flint/dev/seed_demo.py /tmp/flint-demo.db
    FLINT_DB=/tmp/flint-demo.db cargo run -p flint

Same schema as the real store (user_version 4). The accounts have no
credentials, so sync logs an error per account and does nothing else.
Everything here is fictional.
"""

import json
import os
import sqlite3
import sys
import time
import uuid

SCHEMA = """
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, color TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'gmail', refresh_token TEXT, history_id TEXT,
  backfill_page_token TEXT, backfill_done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  gmail_id TEXT, gmail_draft_id TEXT, thread_id TEXT, message_id_hdr TEXT, in_reply_to TEXT,
  refs TEXT NOT NULL DEFAULT '[]', from_name TEXT, from_addr TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]', reply_to_json TEXT,
  subject TEXT NOT NULL DEFAULT '', date INTEGER NOT NULL, snippet TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '', body_html TEXT, folder TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0, answered INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'people', important INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'synced', send_after INTEGER, send_error TEXT,
  body_codec TEXT NOT NULL DEFAULT 'none', body_state TEXT NOT NULL DEFAULT 'full',
  thread_key TEXT GENERATED ALWAYS AS (COALESCE(thread_id, message_id_hdr)) VIRTUAL,
  UNIQUE(account_id, gmail_id), UNIQUE(account_id, message_id_hdr)
);
CREATE INDEX IF NOT EXISTS idx_messages_list ON messages(account_id, folder, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(account_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(account_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread_key ON messages(account_id, thread_key, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_body_codec ON messages(body_codec);
CREATE INDEX IF NOT EXISTS idx_messages_body_missing ON messages(account_id, date DESC) WHERE body_state = 'missing';
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject, body, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS ops (
  id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_due ON ops(state, next_attempt_at);
"""

NOW = int(time.time() * 1000)
H = 3600 * 1000
D = 24 * H

ME = {"name": "Alex Rivera", "address": "alex.rivera@example.com"}
WORK = {"name": "Alex Rivera", "address": "alex@northwind.example"}

NEWSLETTER = """<table width="100%"><tr><td>
<h1>This week in the garden club</h1>
<p>Hello neighbours! The <strong>spring plant swap</strong> is on Saturday at 10am by the
community hall. Bring cuttings, seeds, or just yourself.</p>
<p><img src="https://images.example.com/header.png" width="600" alt="Seedlings"></p>
<ul><li>Tomato seedlings (six varieties)</li><li>Herb starter kits</li><li>Compost workshop at 11:30</li></ul>
<blockquote>"The best time to plant a tree was twenty years ago." — everyone, always</blockquote>
<p><a href="https://example.com/garden-club">See the full schedule</a></p>
</td></tr></table>"""

RELEASE = """<p>Hi Alex,</p><p>Release <code>v2.4.0</code> is tagged. Highlights:</p>
<ol><li>Faster sync for large folders</li><li>Fixed the timezone bug in reminders</li></ol>
<pre><code>cargo install northwind-cli --version 2.4.0</code></pre>
<p>Thanks, <a href="mailto:sam@northwind.example">Sam</a></p>"""

REVIEW = """<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5">
<p><b>@samchen</b> requested changes on this pull request.</p>
<hr style="border:0;border-top:1px solid #d0d7de">
<p>In <a href="https://github.example/northwind/cli/pull/412/files#diff-1">src/sync.rs</a>:</p>
<pre style="background:#f6f8fa;color:#24292f;padding:8px;border-radius:6px;font-size:12px">&gt; let batch = fetch_page(token).await?;
&gt; for msg in batch { store.insert(msg)?; }</pre>
<p>This holds the write lock across the whole page. Can we insert in one transaction instead?</p>
<p style="font-size:12px;color:#57606a">—<br>Reply to this email directly, <a href="https://github.example/northwind/cli/pull/412#pullrequestreview-1">view it on GitHub</a>, or <a href="https://github.example/notifications/unsubscribe">unsubscribe</a>.</p>
<img src="https://github.example/notifications/beacon/abc.gif" height="1" width="1" alt="">
</div>
"""

PROMO = """<html><head><style>
.btn { background:#ff5a5f; color:#ffffff !important; padding:12px 28px; border-radius:6px; text-decoration:none; font-weight:bold; display:inline-block }
@media (max-width: 600px) { .wrap { width:100% !important } }
</style></head>
<body style="margin:0;background:#f2f2f2">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f2f2f2"><tr><td align="center" style="padding:24px 0">
<table class="wrap" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;font-family:Arial,sans-serif;color:#333333">
<tr><td style="padding:28px 32px 8px"><h1 style="margin:0;font-size:26px;color:#111">Your weekend getaway awaits</h1></td></tr>
<tr><td style="padding:8px 32px;font-size:15px;line-height:22px">Cozy cabins near the lake are <b>20% off</b> this month. Book by Sunday to lock in the price.</td></tr>
<tr><td style="padding:8px 32px"><table width="100%"><tr>
<td width="50%" style="padding:8px;background:#fafafa;border:1px solid #eee"><b>Pine Cabin</b><br><span style="color:#888">Sleeps 4 · $129/night</span></td>
<td width="50%" style="padding:8px;background:#fafafa;border:1px solid #eee"><b>Lakeside Loft</b><br><span style="color:#888">Sleeps 2 · $99/night</span></td>
</tr></table></td></tr>
<tr><td align="center" style="padding:20px 32px 28px"><a class="btn" href="https://stays.example/deals">See the deals</a></td></tr>
<tr><td style="padding:16px 32px;font-size:11px;color:#999;border-top:1px solid #eee">You're receiving this because you signed up at stays.example. <a href="https://stays.example/unsub" style="color:#999">Unsubscribe</a></td></tr>
</table></td></tr></table>
<img src="https://track.stays.example/open.gif" width="1" height="1">
</body></html>
"""

QUOTED = """<div dir="ltr">Sounds good, Thursday at 6 works for me. I'll bring the new expansion.<div><br></div><div>— Jake</div></div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Wed, Nov 4, 2026 at 9:12 AM Alex Rivera &lt;alex.rivera@example.com&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">Board games Thursday? Priya might come too.</blockquote></div>
"""


def main(path: str) -> None:
    if os.path.exists(path):
        os.remove(path)
    db = sqlite3.connect(path)
    db.executescript(SCHEMA)
    db.execute("PRAGMA user_version = 4")
    db.execute("PRAGMA journal_mode = WAL")
    accounts = [
        ("acct-personal", ME["address"], ME["name"], "#4E9BF5"),
        ("acct-work", WORK["address"], WORK["name"], "#E5684F"),
    ]
    for i, (aid, email, name, color) in enumerate(accounts):
        db.execute(
            "INSERT INTO accounts (id, email, name, color, backfill_done, created_at) VALUES (?, ?, ?, ?, 1, ?)",
            (aid, email, name, color, NOW - (10 - i) * D),
        )
    db.execute("INSERT INTO config (key, value) VALUES ('setting:signature', '— Alex')")

    seq = [0]

    def msg(acct, thread, frm, to, subject, ago, body, folder="inbox", seen=False, flagged=False,
            important=False, category="people", html=None, state="synced", cc=None, gmail=True,
            send_error=None, reply_to=None):
        seq[0] += 1
        n = seq[0]
        hdr = f"<demo-{n}-{uuid.uuid4().hex[:8]}@example.com>"
        mailbox = lambda m: {k: v for k, v in m.items() if v}
        cur = db.execute(
            """INSERT INTO messages (account_id, gmail_id, thread_id, message_id_hdr, refs, from_name, from_addr,
               to_json, cc_json, reply_to_json, subject, date, snippet, body_text, body_html, folder, seen, flagged,
               category, important, state, send_error)
               VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (acct, f"gm{n}" if gmail else None, thread if gmail else None, hdr, frm.get("name"), frm["address"],
             json.dumps([mailbox(t) for t in to]), json.dumps([mailbox(t) for t in (cc or [])]),
             json.dumps(reply_to) if reply_to else None, subject, NOW - ago, body[:140].replace("\n", " "),
             body, html, folder, int(seen), int(flagged), category, int(important), state, send_error),
        )
        db.execute("INSERT INTO messages_fts (rowid, subject, body) VALUES (?, ?, ?)", (cur.lastrowid, subject, body))
        return hdr

    P, W = "acct-personal", "acct-work"
    priya = {"name": "Priya Raghavan", "address": "priya@example.org"}
    jake = {"name": "Jake Okafor", "address": "jake.okafor@example.net"}
    mom = {"name": "Linda Rivera", "address": "linda.rivera@example.com"}
    sam = {"name": "Sam Chen", "address": "sam@northwind.example"}
    dana = {"name": "Dana Whitfield", "address": "dana@northwind.example"}
    lee = {"address": "lee.m@example.io"}

    # Important conversations (the smart inbox's main list)
    msg(P, "t-trip", priya, [ME], "Lisbon in May?", 9 * D,
        "Hey! Are we still on for Lisbon? I found flights for the 14th.", seen=True, important=True)
    msg(P, "t-trip", ME, [priya], "Re: Lisbon in May?", 8 * D,
        "Yes! The 14th works. Want me to look at places in Alfama?", seen=True, important=True)
    msg(P, "t-trip", priya, [ME, jake], "Re: Lisbon in May?", 2 * H,
        "Booked the flights 🎉\n\nJake is in too. Alfama sounds perfect. Can you send a couple of options by Friday?\n\nAlso: tram 28 at sunrise, non-negotiable.",
        important=True, flagged=True)
    msg(P, "t-dinner", mom, [ME], "Sunday dinner", 5 * H,
        "Your father is making the lamb again. Bring the good bread from the bakery on 5th please!",
        important=True)
    msg(W, "t-release", sam, [WORK], "v2.4.0 is out", 26 * H, "Release v2.4.0 is tagged.", important=True,
        html=RELEASE, seen=True)
    msg(W, "t-review", dana, [WORK], "Q3 planning doc — comments by Thursday", 3 * D,
        "I left a few questions in the risks section. Mostly about the hiring timeline.", important=True, cc=[sam])
    msg(P, "t-lee", lee, [ME], "Camera for sale", 12 * D, "Still have the Fuji? I can pick it up this weekend.",
        important=True, seen=True)

    # Real-world HTML shapes for the renderer: a styled marketing email, a code review
    # notification, a reply quoting the thread
    msg(P, "t-promo", {"name": "Lakeside Stays", "address": "hello@stays.example"}, [ME],
        "Your weekend getaway awaits", 40 * 60 * 1000, "Cozy cabins near the lake are 20% off this month.",
        important=True, html=PROMO)
    msg(W, "t-review412", {"name": "Sam Chen", "address": "notifications@github.example"}, [WORK],
        "Re: [northwind/cli] Batch inserts during sync (PR #412)", 70 * 60 * 1000,
        "@samchen requested changes on this pull request.", important=True, html=REVIEW)
    msg(P, "t-games", ME, [jake], "Board games Thursday?", 2 * D, "Board games Thursday? Priya might come too.",
        seen=True, important=True)
    msg(P, "t-games", jake, [ME], "Re: Board games Thursday?", 100 * 60 * 1000,
        "Sounds good, Thursday at 6 works for me.", important=True, html=QUOTED)

    # Bundles: notifications, people, invites
    for i, (who, subj) in enumerate([
        ({"name": "Garden Club", "address": "news@gardenclub.example"}, "This week in the garden club"),
        ({"name": "Riverside Library", "address": "noreply@library.example"}, "Your hold is ready for pickup"),
        ({"name": "Transit Alerts", "address": "alerts@transit.example"}, "Weekend service changes on the Blue line"),
        ({"name": "Bank of Example", "address": "statements@bank.example"}, "Your October statement is available"),
    ]):
        msg(P, f"t-n{i}", who, [ME], subj, (i + 1) * 7 * H, f"{subj}. Read more inside.",
            category="notifications", seen=i > 1, html=NEWSLETTER if i == 0 else None)
    for i, (who, subj) in enumerate([
        (jake, "Board games Thursday?"),
        ({"name": "Maya Lindqvist", "address": "maya@example.se"}, "Photos from the wedding"),
    ]):
        msg(P, f"t-p{i}", who, [ME], subj, (i + 2) * D, "Let me know what you think!", seen=i == 1)
    msg(W, "t-inv", dana, [WORK], "Invitation: Design review @ Tue 2pm", 4 * H,
        "You have been invited to Design review.", category="invites")

    # Sent, drafts, in-flight
    msg(P, "t-sent", ME, [{"name": "Riverside Dental", "address": "front@dental.example"}],
        "Rescheduling my cleaning", 6 * D, "Could we move my appointment to next week?", folder="sent", seen=True)
    msg(P, None, ME, [jake], "Gift idea for Priya", 3 * H,
        "What about a **film camera**? She mentioned it twice.", folder="drafts", seen=True, state="draft",
        gmail=False, html="<p>What about a <strong>film camera</strong>? She mentioned it twice.</p>")
    msg(W, "t-fail", WORK, [{"address": "vendor@supplies.example"}], "Purchase order 1182", 50 * 60 * 1000,
        "Attached is PO 1182.", folder="sent", seen=True, state="failed",
        send_error="Gmail messages.send failed: 400 Invalid To header")

    # Archive, trash, spam
    msg(P, "t-old", {"name": "Hiking Group", "address": "hikes@example.org"}, [ME], "Trail report: Mount Tam",
        20 * D, "Muddy but gorgeous.", folder="archive", seen=True, important=True)
    msg(P, "t-trash", {"name": "Deals Daily", "address": "deals@spam.example"}, [ME], "Last chance!!", 2 * D,
        "Everything must go.", folder="trash", seen=True, category="notifications")
    msg(P, "t-spam", {"address": "prize@lottery.example"}, [ME], "You have won", 1 * D, "Claim now.",
        folder="spam", category="notifications")

    # Older mail so the list scrolls and pages
    for i in range(70):
        who = [priya, jake, mom, sam, dana][i % 5]
        msg(P if i % 3 else W, f"t-old{i}", who, [ME if i % 3 else WORK], f"Older thread #{i + 1}",
            (14 + i) * D, f"Catching up on item {i + 1}.", seen=True, important=True)

    db.commit()
    db.close()
    print(f"seeded {seq[0]} messages into {path}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/flint-demo.db")
