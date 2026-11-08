//! The app: navigation, shared state, data loading, and every mail action.
//! A port of `src/renderer/src/store.ts` plus the view-level data hooks
//! (`useMailQuery`, `useThreadPages`). Mail is never held here beyond what
//! the current screen shows; each screen asks the store for exactly that and
//! asks again whenever the engine reports a change (`mail_version` ticks).
//!
//! Every store or engine call blocks, so it runs on the background executor
//! and its result is applied back on the main thread. Responses carry a
//! sequence number and stale ones are dropped.

use crate::util::identity::{address_key, parse_address_list, Contacts};
use crate::util::mailhtml::{escape_html, markdown_to_html, markdown_to_text};
use crate::views::compose::ComposerState;
use crate::views::search::SearchState;
use crate::views::settings::SettingsState;
use crate::views::thread::ThreadState;
use flint_core::*;
use futures::channel::mpsc::UnboundedReceiver;
use futures::StreamExt;
use gpui_kit::*;
use std::rc::Rc;
use std::time::Duration;

actions!(
    flint,
    [
        Escape,
        OpenSearch,
        OpenSearchSlash,
        NewMessage,
        OpenSettings,
        GoPins,
        GoDrafts,
        GoSent,
        SendMessage,
        SearchUp,
        SearchDown,
        SearchEnter,
    ]
);

pub const KEY_CONTEXT: &str = "Flint";

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("escape", Escape, Some(KEY_CONTEXT)),
        KeyBinding::new("cmd-k", OpenSearch, Some(KEY_CONTEXT)),
        KeyBinding::new("/", OpenSearchSlash, Some(KEY_CONTEXT)),
        KeyBinding::new("cmd-n", NewMessage, Some(KEY_CONTEXT)),
        KeyBinding::new("cmd-,", OpenSettings, Some(KEY_CONTEXT)),
        KeyBinding::new("shift-p", GoPins, Some(KEY_CONTEXT)),
        KeyBinding::new("shift-d", GoDrafts, Some(KEY_CONTEXT)),
        KeyBinding::new("shift-s", GoSent, Some(KEY_CONTEXT)),
        KeyBinding::new("cmd-enter", SendMessage, Some("Compose")),
        KeyBinding::new("cmd-enter", SendMessage, Some("Compose > Input")),
        KeyBinding::new("up", SearchUp, Some("Search > Input")),
        KeyBinding::new("down", SearchDown, Some("Search > Input")),
        KeyBinding::new("enter", SearchEnter, Some("Search > Input")),
    ]);
}

/// Folder-style lists reachable from the header menu ('Pins' = flagged, not a folder)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FolderView {
    Pins,
    Drafts,
    Sent,
    Trash,
    Spam,
    Archive,
}

impl FolderView {
    pub const MENU: [FolderView; 6] = [
        FolderView::Pins,
        FolderView::Drafts,
        FolderView::Sent,
        FolderView::Trash,
        FolderView::Spam,
        FolderView::Archive,
    ];

    pub fn title(self) -> &'static str {
        match self {
            FolderView::Pins => "Pins",
            FolderView::Drafts => "Drafts",
            FolderView::Sent => "Sent",
            FolderView::Trash => "Trash",
            FolderView::Spam => "Spam",
            FolderView::Archive => "Archive",
        }
    }

    pub fn shortcut(self) -> Option<&'static str> {
        match self {
            FolderView::Pins => Some("⇧P"),
            FolderView::Drafts => Some("⇧D"),
            FolderView::Sent => Some("⇧S"),
            _ => None,
        }
    }
}

pub fn category_label(category: &str) -> String {
    match category {
        "notifications" => "Notifications".into(),
        "people" => "People".into(),
        "invites" => "Invites".into(),
        other => other.to_string(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Screen {
    Inbox,
    Group(String),
    Folder(FolderView),
    Thread(ThreadRef),
    Settings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Popover {
    Menu,
    Filter,
}

pub type Handler = Rc<dyn Fn(&mut FlintApp, &mut Window, &mut Context<FlintApp>)>;

pub struct Toast {
    pub id: u64,
    pub text: SharedString,
    pub undo: Option<Handler>,
}

pub enum MenuEntry {
    Item(SharedString, Handler),
    Separator,
}

pub struct ContextMenu {
    pub position: Point<Pixels>,
    pub entries: Vec<MenuEntry>,
}

/// One thread list (inbox, a smart-inbox group, a folder) and its pages
pub struct ListPage {
    pub overview: Option<InboxOverview>,
    pub threads: Vec<WireThread>,
    pub drafts: Vec<WireMessage>,
    pub cursor: Option<ThreadCursor>,
    pub has_more: bool,
    pub loading: bool,
    pub loaded_once: bool,
    seq: u64,
}

impl ListPage {
    fn new() -> Self {
        ListPage {
            overview: None,
            threads: Vec::new(),
            drafts: Vec::new(),
            cursor: None,
            has_more: false,
            loading: true,
            loaded_once: false,
            seq: 0,
        }
    }
}

pub enum PageState {
    List(ListPage),
    Thread(ThreadState),
    Settings(SettingsState),
}

pub const THREAD_PAGE: usize = 50;
/// Undo window before a reply actually leaves the machine
pub const UNDO_SEND_MS: i64 = 5000;
const TOAST_MS: u64 = 3200;

pub const SETTING_SIGNATURE: &str = "signature";
pub const SETTING_HIDE_DONE: &str = "hide_done";
pub const SETTING_WORD_COUNT: &str = "show_word_count";

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn make_message_id() -> String {
    format!("<{}@flint.local>", uuid::Uuid::new_v4())
}

pub struct FlintApp {
    pub engine: Engine,
    pub focus: FocusHandle,
    pub scroll: ScrollHandle,

    pub view: Screen,
    pub prev_view: Option<Screen>,
    pub popover: Option<Popover>,
    /// None = every account
    pub active_account: Option<String>,
    pub accounts: Vec<WireAccount>,
    pub mail_version: u64,
    pub contacts: Rc<Contacts>,
    pub outbox: Vec<WireOp>,
    pub unread: Vec<UnreadCount>,

    pub hide_done: bool,
    pub signature: String,
    pub show_word_count: bool,

    pub toast: Option<Toast>,
    toast_seq: u64,
    pub context_menu: Option<ContextMenu>,

    pub page: PageState,
    pub search: Option<SearchState>,
    pub composer: Option<ComposerState>,
    pub startup_error: Option<String>,
}

impl FlintApp {
    pub fn new(
        engine: Engine,
        changes: UnboundedReceiver<()>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let focus = cx.focus_handle();
        window.focus(&focus, cx);

        // Engine change pushes → re-run what is on screen (bursts coalesce)
        cx.spawn(async move |this, cx| {
            let mut changes = changes;
            while changes.next().await.is_some() {
                while changes.try_recv().is_ok() {}
                if this.update(cx, |this, cx| this.on_mail_changed(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();

        let mut app = FlintApp {
            engine,
            focus,
            scroll: ScrollHandle::new(),
            view: Screen::Inbox,
            prev_view: None,
            popover: None,
            active_account: None,
            accounts: Vec::new(),
            mail_version: 0,
            contacts: Rc::new(Contacts::default()),
            outbox: Vec::new(),
            unread: Vec::new(),
            hide_done: true,
            signature: String::new(),
            show_word_count: true,
            toast: None,
            toast_seq: 0,
            context_menu: None,
            page: PageState::List(ListPage::new()),
            search: None,
            composer: None,
            startup_error: None,
        };
        app.init(cx);
        app
    }

    pub fn connected(&self) -> bool {
        !self.accounts.is_empty()
    }

    pub fn scope(&self) -> Option<String> {
        self.active_account.clone()
    }

    /// Is this one of the user's own addresses (or a +alias of one)?
    pub fn is_own_address(&self, address: &str) -> bool {
        let key = address_key(address);
        self.accounts.iter().any(|a| address_key(&a.email) == key)
    }

    pub fn account(&self, id: &str) -> Option<&WireAccount> {
        self.accounts.iter().find(|a| a.id == id)
    }

    // ---------- background plumbing ----------

    /// Run blocking `work` off the main thread, then `done` back on it
    pub fn bg<R: Send + 'static>(
        &self,
        cx: &mut Context<Self>,
        work: impl FnOnce(&Engine) -> R + Send + 'static,
        done: impl FnOnce(&mut Self, R, &mut Context<Self>) + 'static,
    ) {
        let engine = self.engine.clone();
        let task = cx.background_spawn(async move { work(&engine) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                done(this, result, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Fire-and-forget engine call; failures are logged
    pub fn run(
        &self,
        cx: &mut Context<Self>,
        what: &'static str,
        work: impl FnOnce(&Engine) -> anyhow::Result<()> + Send + 'static,
    ) {
        let engine = self.engine.clone();
        cx.background_spawn(async move {
            if let Err(err) = work(&engine) {
                log::error!("{what} failed: {err:#}");
            }
        })
        .detach();
    }

    // ---------- loading ----------

    /// Hydrate accounts and settings (empty state when there is no account)
    pub fn init(&mut self, cx: &mut Context<Self>) {
        self.bg(
            cx,
            |engine| {
                let store = engine.store();
                Ok::<_, anyhow::Error>((store.list_accounts()?, store.settings()?))
            },
            |this, result, cx| match result {
                Ok((accounts, settings)) => {
                    this.signature = settings.get(SETTING_SIGNATURE).cloned().unwrap_or_default();
                    this.hide_done = settings.get(SETTING_HIDE_DONE).map(|v| v != "false").unwrap_or(true);
                    this.show_word_count =
                        settings.get(SETTING_WORD_COUNT).map(|v| v != "false").unwrap_or(true);
                    if let Some(active) = &this.active_account {
                        if !accounts.iter().any(|a| &a.id == active) {
                            this.active_account = None;
                        }
                    }
                    this.accounts = accounts;
                    this.mail_version += 1;
                    this.load_shared(cx);
                    this.reload_page(cx);
                }
                Err(err) => {
                    log::error!("init failed: {err:#}");
                    this.startup_error = Some(format!("{err:#}"));
                }
            },
        );
    }

    fn on_mail_changed(&mut self, cx: &mut Context<Self>) {
        self.mail_version += 1;
        self.load_shared(cx);
        self.reload_page(cx);
        if let Some(search) = &self.search {
            let query = search.settled.clone();
            self.run_search(query, cx);
        }
        cx.notify();
    }

    /// Contacts, outbox trouble, unread counts: cheap, refreshed on each change
    pub fn load_shared(&mut self, cx: &mut Context<Self>) {
        if !self.connected() {
            self.contacts = Rc::new(Contacts::default());
            self.outbox.clear();
            self.unread.clear();
            return;
        }
        let scope = self.scope();
        self.bg(
            cx,
            move |engine| {
                let store = engine.store();
                Ok::<_, anyhow::Error>((
                    store.list_contacts(scope.as_deref())?,
                    engine.list_outbox()?,
                    store.unread_counts()?,
                ))
            },
            |this, result, _cx| match result {
                Ok((contacts, outbox, unread)) => {
                    this.contacts = Rc::new(Contacts::new(&contacts));
                    this.outbox = outbox;
                    this.unread = unread;
                }
                Err(err) => log::error!("reload failed: {err:#}"),
            },
        );
    }

    /// The thread-list query a list view shows; None for Drafts (individual messages)
    pub fn list_query(&self) -> Option<ThreadListView> {
        let include_archived = !self.hide_done;
        match &self.view {
            Screen::Inbox => Some(ThreadListView::Inbox {
                include_archived,
                category: None,
                important_only: true,
            }),
            Screen::Group(category) => Some(ThreadListView::Inbox {
                include_archived,
                category: Some(category.clone()),
                important_only: false,
            }),
            Screen::Folder(FolderView::Pins) => Some(ThreadListView::Pins),
            Screen::Folder(FolderView::Drafts) => None,
            Screen::Folder(FolderView::Sent) => Some(ThreadListView::Folder(Folder::Sent)),
            Screen::Folder(FolderView::Trash) => Some(ThreadListView::Folder(Folder::Trash)),
            Screen::Folder(FolderView::Spam) => Some(ThreadListView::Folder(Folder::Spam)),
            Screen::Folder(FolderView::Archive) => Some(ThreadListView::Folder(Folder::Archive)),
            Screen::Thread(_) | Screen::Settings => None,
        }
    }

    /// Re-run the current screen's query. Lists reload as many pages as were
    /// loaded before (so the scroll position survives a refresh).
    pub fn reload_page(&mut self, cx: &mut Context<Self>) {
        if !self.connected() {
            return;
        }
        match &mut self.page {
            PageState::List(list) => {
                list.seq += 1;
                let seq = list.seq;
                let wanted = list.threads.len().div_ceil(THREAD_PAGE).max(1);
                let scope = self.active_account.clone();
                let is_inbox = self.view == Screen::Inbox;
                let is_drafts = self.view == Screen::Folder(FolderView::Drafts);
                let query = self.list_query();
                let include_archived = !self.hide_done;
                self.bg(
                    cx,
                    move |engine| -> anyhow::Result<(Option<InboxOverview>, Vec<WireThread>, Option<ThreadCursor>, Vec<WireMessage>)> {
                        let store = engine.store();
                        if is_drafts {
                            return Ok((None, Vec::new(), None, store.list_drafts(scope.as_deref())?));
                        }
                        let overview = if is_inbox {
                            Some(store.inbox_overview(scope.as_deref(), include_archived)?)
                        } else {
                            None
                        };
                        let mut threads = Vec::new();
                        let mut cursor = None;
                        if let Some(view) = query {
                            for _ in 0..wanted {
                                let page = store.list_threads(&ThreadQuery {
                                    account_id: scope.clone(),
                                    view: view.clone(),
                                    cursor: cursor.clone(),
                                    limit: THREAD_PAGE,
                                })?;
                                threads.extend(page.threads);
                                cursor = page.next_cursor;
                                if cursor.is_none() {
                                    break;
                                }
                            }
                        }
                        Ok((overview, threads, cursor, Vec::new()))
                    },
                    move |this, result, _cx| {
                        let PageState::List(list) = &mut this.page else { return };
                        if list.seq != seq {
                            return;
                        }
                        list.loading = false;
                        list.loaded_once = true;
                        match result {
                            Ok((overview, threads, cursor, drafts)) => {
                                list.overview = overview;
                                list.has_more = cursor.is_some();
                                list.threads = threads;
                                list.cursor = cursor;
                                list.drafts = drafts;
                            }
                            Err(err) => log::error!("thread list failed: {err:#}"),
                        }
                    },
                );
            }
            PageState::Thread(_) => self.load_thread(cx),
            PageState::Settings(_) => {}
        }
    }

    /// Next page of the current list (no-op while loading or when exhausted)
    pub fn load_more(&mut self, cx: &mut Context<Self>) {
        let Some(view) = self.list_query() else { return };
        let PageState::List(list) = &mut self.page else { return };
        if list.loading || !list.has_more {
            return;
        }
        let Some(cursor) = list.cursor.clone() else { return };
        list.loading = true;
        let seq = list.seq;
        let scope = self.active_account.clone();
        self.bg(
            cx,
            move |engine| {
                engine.store().list_threads(&ThreadQuery {
                    account_id: scope,
                    view,
                    cursor: Some(cursor),
                    limit: THREAD_PAGE,
                })
            },
            move |this, result, _cx| {
                let PageState::List(list) = &mut this.page else { return };
                if list.seq != seq {
                    return;
                }
                list.loading = false;
                match result {
                    Ok(page) => {
                        list.threads.extend(page.threads);
                        list.has_more = page.next_cursor.is_some();
                        list.cursor = page.next_cursor;
                    }
                    Err(err) => log::error!("thread page failed: {err:#}"),
                }
            },
        );
    }

    // ---------- navigation ----------

    fn enter(&mut self, view: Screen, window: &mut Window, cx: &mut Context<Self>) {
        self.popover = None;
        self.context_menu = None;
        self.page = match &view {
            Screen::Thread(r) => PageState::Thread(ThreadState::new(r.clone(), self, window, cx)),
            Screen::Settings => PageState::Settings(SettingsState::new(self, window, cx)),
            _ => PageState::List(ListPage::new()),
        };
        self.view = view;
        self.scroll = ScrollHandle::new();
        if self.composer.is_none() && self.search.is_none() {
            window.focus(&self.focus, cx);
        }
        if let PageState::Settings(_) = self.page {
            self.start_status_poll(cx);
        }
        self.reload_page(cx);
        cx.notify();
    }

    fn remembers(view: &Screen) -> bool {
        !matches!(view, Screen::Thread(_) | Screen::Settings)
    }

    pub fn go_inbox(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.prev_view = None;
        self.enter(Screen::Inbox, window, cx);
    }

    pub fn open_group(&mut self, category: String, window: &mut Window, cx: &mut Context<Self>) {
        self.enter(Screen::Group(category), window, cx);
    }

    pub fn open_folder(&mut self, folder: FolderView, window: &mut Window, cx: &mut Context<Self>) {
        self.prev_view = None;
        self.enter(Screen::Folder(folder), window, cx);
    }

    pub fn open_thread(&mut self, r: ThreadRef, window: &mut Window, cx: &mut Context<Self>) {
        if Self::remembers(&self.view) {
            self.prev_view = Some(self.view.clone());
        }
        self.enter(Screen::Thread(r.clone()), window, cx);
        self.thread_action(vec![r], ThreadAction::MarkSeen, cx);
    }

    pub fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if Self::remembers(&self.view) {
            self.prev_view = Some(self.view.clone());
        }
        self.enter(Screen::Settings, window, cx);
    }

    pub fn back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let target = match self.view {
            Screen::Thread(_) | Screen::Settings => self.prev_view.take().unwrap_or(Screen::Inbox),
            _ => Screen::Inbox,
        };
        self.prev_view = None;
        self.enter(target, window, cx);
    }

    pub fn set_popover(&mut self, popover: Option<Popover>, cx: &mut Context<Self>) {
        self.popover = popover;
        cx.notify();
    }

    pub fn set_account(&mut self, account: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.active_account = account;
        self.popover = None;
        self.load_shared(cx);
        let view = self.view.clone();
        let prev = self.prev_view.clone();
        self.enter(view, window, cx);
        self.prev_view = prev;
    }

    // ---------- mail actions ----------

    pub fn thread_action(&mut self, refs: Vec<ThreadRef>, action: ThreadAction, cx: &mut Context<Self>) {
        if !self.connected() || refs.is_empty() {
            return;
        }
        self.run(cx, "thread action", move |engine| engine.thread_action(&refs, action));
    }

    /// Archive a conversation with an undo toast ("Done")
    pub fn done(&mut self, r: ThreadRef, cx: &mut Context<Self>) {
        self.thread_action(vec![r.clone()], ThreadAction::Archive, cx);
        let undo: Handler = Rc::new(move |this, _, cx| {
            this.thread_action(vec![r.clone()], ThreadAction::ToggleArchive, cx)
        });
        self.show_toast("Marked done", Some(undo), cx);
    }

    /// "Mark all done" for a smart-inbox group: every conversation in it
    pub fn archive_group(&mut self, category: String, cx: &mut Context<Self>) {
        if !self.connected() {
            return;
        }
        let scope = self.scope();
        let include_archived = !self.hide_done;
        self.bg(
            cx,
            move |engine| -> anyhow::Result<Vec<ThreadRef>> {
                let mut refs = Vec::new();
                let mut cursor = None;
                loop {
                    let page = engine.store().list_threads(&ThreadQuery {
                        account_id: scope.clone(),
                        view: ThreadListView::Inbox {
                            include_archived,
                            category: Some(category.clone()),
                            important_only: false,
                        },
                        cursor,
                        limit: 200,
                    })?;
                    refs.extend(page.threads.iter().map(|t| t.thread_ref()));
                    cursor = page.next_cursor;
                    if cursor.is_none() {
                        break;
                    }
                }
                if !refs.is_empty() {
                    engine.thread_action(&refs, ThreadAction::Archive)?;
                }
                Ok(refs)
            },
            |this, result, cx| match result {
                Ok(refs) if !refs.is_empty() => {
                    let undo: Handler = Rc::new(move |this, _, cx| {
                        this.thread_action(refs.clone(), ThreadAction::ToggleArchive, cx)
                    });
                    this.show_toast("All done", Some(undo), cx);
                }
                Ok(_) => {}
                Err(err) => log::error!("archive group failed: {err:#}"),
            },
        );
    }

    pub fn delete_draft(&mut self, account_id: String, hdr: String, cx: &mut Context<Self>) {
        self.run(cx, "delete draft", move |engine| engine.delete_local(&account_id, &hdr));
    }

    /// Plain-text part: paragraphs, then the signature as its own paragraph
    pub fn with_signature_text(&self, text: &str) -> String {
        if self.signature.trim().is_empty() {
            return text.to_string();
        }
        format!("{}\n\n{}", text.trim_end(), self.signature)
    }

    pub fn with_signature_html(&self, html: &str) -> String {
        if self.signature.trim().is_empty() {
            return html.to_string();
        }
        format!("{html}<p>{}</p>", escape_html(&self.signature).replace('\n', "<br />"))
    }

    /// Queue a reply to the latest counterpart and return its Message-ID.
    /// Recipients and body are fixed now, so nothing during the undo window
    /// can change where it goes.
    pub fn send_reply(
        &mut self,
        thread: &[WireMessage],
        markdown: &str,
        cx: &mut Context<Self>,
    ) -> Option<(String, String)> {
        if markdown.trim().is_empty() || !self.connected() {
            return None;
        }
        let mut in_thread: Vec<&WireMessage> = thread.iter().collect();
        in_thread.sort_by_key(|m| m.date_ms);
        let latest = *in_thread.last()?;
        let counterpart = in_thread.iter().rev().find(|m| !self.is_own_address(&m.from.address));
        let target = counterpart.copied().unwrap_or(latest);
        let recipients = if self.is_own_address(&target.from.address) {
            target.to.clone()
        } else {
            vec![target.reply_to.clone().unwrap_or_else(|| target.from.clone())]
        };
        let account_id = self
            .account(&target.account_id)
            .or(self.accounts.first())
            .map(|a| a.id.clone())?;
        let hdr = make_message_id();
        let parent = latest.message_id_hdr.clone();
        let mut references = latest.references.clone();
        if let Some(p) = &parent {
            references.push(p.clone());
        }
        let subject = if latest.subject.to_lowercase().starts_with("re:") {
            latest.subject.clone()
        } else {
            format!("Re: {}", latest.subject)
        };
        let input = LocalMessageInput {
            account_id: account_id.clone(),
            message_id_hdr: Some(hdr.clone()),
            to: recipients,
            cc: Vec::new(),
            subject,
            text: self.with_signature_text(&markdown_to_text(markdown)),
            html: Some(self.with_signature_html(&markdown_to_html(markdown))),
            in_reply_to: parent,
            references,
            thread_id: in_thread.iter().rev().find_map(|m| m.thread_id.clone()),
            category: Some(latest.category.clone()),
        };
        let send_after = now_ms() + UNDO_SEND_MS;
        self.run(cx, "send reply", move |engine| engine.queue_send(input, send_after).map(|_| ()));
        Some((account_id, hdr))
    }

    pub fn unsend(&mut self, account_id: String, hdr: String, cx: &mut Context<Self>) {
        self.run(cx, "undo send", move |engine| engine.cancel_send(&account_id, &hdr, false).map(|_| ()));
    }

    pub fn revert_to_draft(&mut self, m: &WireMessage, cx: &mut Context<Self>) {
        let (account_id, hdr) = (m.account_id.clone(), m.message_id_hdr.clone().unwrap_or_default());
        self.run(cx, "revert to draft", move |engine| engine.cancel_send(&account_id, &hdr, true).map(|_| ()));
    }

    pub fn retry_send(&mut self, m: &WireMessage, cx: &mut Context<Self>) {
        let (account_id, hdr) = (m.account_id.clone(), m.message_id_hdr.clone().unwrap_or_default());
        self.run(cx, "retry send", move |engine| engine.retry_send(&account_id, &hdr));
    }

    pub fn retry_outbox(&mut self, cx: &mut Context<Self>) {
        self.run(cx, "retry outbox", |engine| engine.retry_outbox(None));
    }

    pub fn discard_outbox(&mut self, cx: &mut Context<Self>) {
        self.run(cx, "discard outbox", |engine| engine.discard_outbox(None));
    }

    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.connected() {
            self.run(cx, "refresh", |engine| engine.refresh());
        }
    }

    /// Build the input for a composed message (New Message / draft), Markdown body
    pub fn composed_input(
        &self,
        to: &str,
        subject: &str,
        markdown: &str,
        account_id: &str,
        existing: Option<&WireMessage>,
        with_signature: bool,
    ) -> Option<LocalMessageInput> {
        let account = self.account(account_id).or(self.accounts.first())?;
        let has_body = !markdown.trim().is_empty();
        let text = markdown_to_text(markdown);
        let html = has_body.then(|| markdown_to_html(markdown));
        Some(LocalMessageInput {
            account_id: account.id.clone(),
            message_id_hdr: Some(
                existing.and_then(|m| m.message_id_hdr.clone()).unwrap_or_else(make_message_id),
            ),
            to: parse_address_list(to),
            cc: Vec::new(),
            subject: if subject.trim().is_empty() { "(no subject)".into() } else { subject.to_string() },
            text: if with_signature { self.with_signature_text(&text) } else { text },
            html: html.map(|h| if with_signature { self.with_signature_html(&h) } else { h }),
            in_reply_to: existing.and_then(|m| m.in_reply_to.clone()),
            references: existing.map(|m| m.references.clone()).unwrap_or_default(),
            thread_id: existing.and_then(|m| m.thread_id.clone()),
            category: Some(existing.map(|m| m.category.clone()).unwrap_or_else(|| "people".into())),
        })
    }

    // ---------- settings ----------

    pub fn persist_setting(&self, key: &'static str, value: String, cx: &mut Context<Self>) {
        self.run(cx, "save setting", move |engine| engine.store().set_setting(key, &value));
    }

    pub fn toggle_hide_done(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.hide_done = !self.hide_done;
        self.persist_setting(SETTING_HIDE_DONE, self.hide_done.to_string(), cx);
        let _ = window;
        cx.notify();
    }

    pub fn toggle_word_count(&mut self, cx: &mut Context<Self>) {
        self.show_word_count = !self.show_word_count;
        self.persist_setting(SETTING_WORD_COUNT, self.show_word_count.to_string(), cx);
        cx.notify();
    }

    // ---------- toast ----------

    pub fn show_toast(&mut self, text: impl Into<SharedString>, undo: Option<Handler>, cx: &mut Context<Self>) {
        self.toast_seq += 1;
        let id = self.toast_seq;
        self.toast = Some(Toast { id, text: text.into(), undo });
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(TOAST_MS)).await;
            this.update(cx, |this, cx| {
                if this.toast.as_ref().is_some_and(|t| t.id == id) {
                    this.toast = None;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    pub fn dismiss_toast(&mut self, cx: &mut Context<Self>) {
        self.toast = None;
        cx.notify();
    }

    // ---------- keyboard ----------

    /// True while a text field has focus (bare-key shortcuts must not fire)
    pub fn editing(&self, window: &Window, cx: &App) -> bool {
        match window.focused(cx) {
            Some(f) => f != self.focus,
            None => false,
        }
    }

    pub fn on_escape(&mut self, _: &Escape, window: &mut Window, cx: &mut Context<Self>) {
        // Topmost layer only: search > menus > composer > reply > back
        if self.search.is_some() {
            self.close_search(window, cx);
        } else if self.context_menu.is_some() || self.popover.is_some() {
            self.context_menu = None;
            self.popover = None;
            cx.notify();
        } else if self.composer.is_some() {
            self.composer_close(window, cx);
        } else if self.reply_escape(window, cx) {
        } else if matches!(self.view, Screen::Thread(_) | Screen::Settings) {
            self.back(window, cx);
        } else if matches!(self.view, Screen::Group(_)) {
            self.go_inbox(window, cx);
        } else {
            cx.propagate();
        }
    }

    pub fn on_open_search(&mut self, _: &OpenSearch, window: &mut Window, cx: &mut Context<Self>) {
        self.open_search(window, cx);
    }

    pub fn on_open_search_slash(&mut self, _: &OpenSearchSlash, window: &mut Window, cx: &mut Context<Self>) {
        if self.editing(window, cx) || self.search.is_some() {
            cx.propagate();
            return;
        }
        self.open_search(window, cx);
    }

    pub fn on_new_message(&mut self, _: &NewMessage, window: &mut Window, cx: &mut Context<Self>) {
        // Inert while composing: re-opening would wipe unsaved edits
        if self.composer.is_none() && self.connected() {
            self.open_compose(None, None, window, cx);
        }
    }

    pub fn on_open_settings(&mut self, _: &OpenSettings, window: &mut Window, cx: &mut Context<Self>) {
        if self.composer.is_none() {
            self.open_settings(window, cx);
        }
    }

    fn folder_shortcut(&mut self, folder: FolderView, window: &mut Window, cx: &mut Context<Self>) {
        if self.editing(window, cx) || self.composer.is_some() || self.search.is_some() {
            cx.propagate();
            return;
        }
        self.open_folder(folder, window, cx);
    }

    pub fn on_go_pins(&mut self, _: &GoPins, window: &mut Window, cx: &mut Context<Self>) {
        self.folder_shortcut(FolderView::Pins, window, cx);
    }

    pub fn on_go_drafts(&mut self, _: &GoDrafts, window: &mut Window, cx: &mut Context<Self>) {
        self.folder_shortcut(FolderView::Drafts, window, cx);
    }

    pub fn on_go_sent(&mut self, _: &GoSent, window: &mut Window, cx: &mut Context<Self>) {
        self.folder_shortcut(FolderView::Sent, window, cx);
    }

    pub fn on_send(&mut self, _: &SendMessage, window: &mut Window, cx: &mut Context<Self>) {
        if self.composer.is_some() {
            self.composer_send(window, cx);
        } else {
            self.reply_send(window, cx);
        }
    }
}
