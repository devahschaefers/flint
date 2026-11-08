//! One conversation, fetched whole when opened (missing bodies pulled from
//! Gmail first) and re-fetched on every mail change. Older messages fold to
//! one line; HTML bodies are sanitized with remote images blocked until the
//! reader asks. The reply composer at the end has three layers: a quiet pill,
//! a docked card (drag-resizable), and fullscreen. Port of ThreadView.tsx and
//! ReplyComposer.tsx.

use crate::app::*;
use crate::theme::*;
use crate::util::dates::short_date;
use crate::util::identity::normalize_subject;
use crate::util::mailhtml::sanitize_for_display;
use crate::views::editor::{self, editor_surface, slash_active, slash_menu, toolbar};
use crate::views::list::send_status;
use crate::views::widgets::*;
use flint_core::*;
use gpui_kit::base::input::{InputEvent, TextareaState};
use gpui_kit::base::text::{TextView, TextViewStyle};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use std::collections::HashSet;
use std::rc::Rc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplyMode {
    Collapsed,
    Open,
    Full,
}

pub struct ThreadState {
    pub thread_ref: ThreadRef,
    pub messages: Vec<WireMessage>,
    pub loaded: bool,
    seq: u64,
    expanded: HashSet<String>,
    /// Messages whose remote images the reader chose to load
    images: HashSet<String>,
    pub reply_mode: ReplyMode,
    pub reply: Entity<TextareaState>,
    pub reply_text: String,
    placeholder: String,
    custom_height: Option<Pixels>,
    drag: Option<(Pixels, Pixels)>,
    _subs: Vec<Subscription>,
}

fn message_key(m: &WireMessage) -> String {
    m.message_id_hdr.clone().or_else(|| m.gmail_id.clone()).unwrap_or_default()
}

impl ThreadState {
    pub fn new(thread_ref: ThreadRef, _app: &FlintApp, window: &mut Window, cx: &mut Context<FlintApp>) -> Self {
        let reply = cx.new(|cx| TextareaState::new(window, cx).placeholder("Reply…").auto_grow(4, 18));
        let sub = cx.subscribe_in(&reply, window, |this: &mut FlintApp, state, ev: &InputEvent, _, cx| {
            if let InputEvent::Change = ev {
                let text = state.read(cx).value().to_string();
                if let PageState::Thread(t) = &mut this.page {
                    t.reply_text = text;
                }
                cx.notify();
            }
        });
        ThreadState {
            thread_ref,
            messages: Vec::new(),
            loaded: false,
            seq: 0,
            expanded: HashSet::new(),
            images: HashSet::new(),
            reply_mode: ReplyMode::Collapsed,
            reply,
            reply_text: String::new(),
            placeholder: "Reply…".into(),
            custom_height: None,
            drag: None,
            _subs: vec![sub],
        }
    }
}

impl FlintApp {
    pub fn load_thread(&mut self, cx: &mut Context<Self>) {
        let PageState::Thread(t) = &mut self.page else { return };
        t.seq += 1;
        let seq = t.seq;
        let r = t.thread_ref.clone();
        self.bg(
            cx,
            move |engine| engine.get_thread(&r),
            move |this, result, _| {
                let PageState::Thread(t) = &mut this.page else { return };
                if t.seq != seq {
                    return;
                }
                t.loaded = true;
                match result {
                    Ok(mut messages) => {
                        messages.sort_by_key(|m| m.date_ms);
                        t.messages = messages;
                    }
                    Err(err) => log::error!("thread load failed: {err:#}"),
                }
            },
        );
    }

    fn thread(&self) -> Option<&ThreadState> {
        match &self.page {
            PageState::Thread(t) => Some(t),
            _ => None,
        }
    }

    fn thread_mut(&mut self) -> Option<&mut ThreadState> {
        match &mut self.page {
            PageState::Thread(t) => Some(t),
            _ => None,
        }
    }

    pub fn render_thread(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(t) = self.thread() else { return div().into_any_element() };
        let messages = t.messages.clone();
        let r = t.thread_ref.clone();
        if messages.is_empty() {
            // Loading, or deleted elsewhere: keep the chrome
            let back = self.back_link(cx).into_any_element();
            return self.page("page-thread", true, div().child(back));
        }

        let latest = messages.last().cloned().unwrap();
        let subject = Some(normalize_subject(&messages[0].subject)).filter(|s| !s.is_empty()).unwrap_or_else(|| "(no subject)".into());
        let flagged = messages.iter().any(|m| m.flagged);
        let in_inbox = messages.iter().any(|m| m.folder == Folder::Inbox);

        // Reply targets the latest counterpart (Reply-To wins); on a pure sent thread, its recipients
        let counterpart = messages.iter().rev().find(|m| !self.is_own_address(&m.from.address));
        let reply_mailbox = match counterpart {
            Some(m) => Some(m.reply_to.clone().unwrap_or_else(|| m.from.clone())),
            None => latest.to.first().cloned(),
        };
        let reply_label = match reply_mailbox {
            Some(m) => {
                let id = self.contacts.resolve(&m);
                let name = if id.is_bare_address { id.name } else { id.name.split(' ').next().unwrap_or("").to_string() };
                format!("Reply to {name}…")
            }
            None => "Reply…".to_string(),
        };

        let (r_done, r_pin) = (r.clone(), r.clone());
        let mut col = div()
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .child(self.back_link(cx))
                    .child(spacer())
                    .child(
                        div()
                            .flex()
                            .gap(px(4.))
                            .when(in_inbox, |d| {
                                d.child(text_action(
                                    "thread-done",
                                    "Done",
                                    true,
                                    Box::new(cx.listener(move |this, _, window, cx| {
                                        this.done(r_done.clone(), cx);
                                        this.back(window, cx);
                                    })),
                                ))
                            })
                            .child(text_action(
                                "thread-pin",
                                if flagged { "Unpin" } else { "Pin" },
                                true,
                                Box::new(cx.listener(move |this, _, _, cx| this.thread_action(vec![r_pin.clone()], ThreadAction::ToggleFlagged, cx))),
                            )),
                    ),
            )
            .child(
                div()
                    .mt(px(18.))
                    .text_size(px(20.))
                    .line_height(px(26.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(c(INK))
                    .child(subject),
            );

        let n = messages.len();
        let expanded = self.thread().map(|t| t.expanded.clone()).unwrap_or_default();
        for (i, m) in messages.iter().enumerate() {
            let key = message_key(m);
            let always = n <= 2 || i >= n - 2;
            if !(always || expanded.contains(&key)) {
                col = col.child(self.collapsed_message(i, m, cx));
                continue;
            }
            let block = self.message_block(i, m, i == 0, window, cx);
            if m.folder == Folder::Drafts {
                // An unsent draft opens in the composer instead of reading as sent mail
                let draft = m.clone();
                col = col.child(
                    div()
                        .id(("draft-block", i))
                        .mx(px(-12.))
                        .px(px(12.))
                        .pb(px(8.))
                        .rounded(px(10.))
                        .cursor_pointer()
                        .hover(|s| s.bg(c(ROW)))
                        .on_click(cx.listener(move |this, _, window, cx| this.open_compose(Some(draft.clone()), None, window, cx)))
                        .child(block),
                );
            } else {
                col = col.child(block);
            }
        }
        col = col.child(self.render_reply(reply_label, window, cx));
        self.page("page-thread", true, col)
    }

    /// "to you", "to you +2", "to Priya, Jake"
    fn recipients_label(&self, m: &WireMessage) -> String {
        let others: Vec<_> = m.to.iter().filter(|r| !self.is_own_address(&r.address)).cloned().collect();
        if others.len() < m.to.len() {
            return if others.is_empty() { "to you".into() } else { format!("to you +{}", others.len()) };
        }
        if m.to.is_empty() {
            return "to (no recipient)".into();
        }
        format!("to {}", self.contacts.names(&m.to))
    }

    fn message_block(&mut self, i: usize, m: &WireMessage, first: bool, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let id = self.contacts.resolve(&m.from);
        let own = self.is_own_address(&m.from.address);
        let cc = if m.cc.is_empty() { String::new() } else { format!(", cc {}", self.contacts.names(&m.cc)) };
        let key = message_key(m);
        let is_draft = m.folder == Folder::Drafts;

        let header = div()
            .flex()
            .items_baseline()
            .justify_between()
            .gap(px(12.))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_baseline()
                    .min_w_0()
                    .gap(px(4.))
                    .child(
                        div()
                            .text_size(px(13.5))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(c(INK))
                            .child(if own { "You".to_string() } else { id.name.clone() }),
                    )
                    .child(div().text_size(px(12.)).text_color(c(LABEL)).child(format!("{}{cc}", self.recipients_label(m))))
                    .when(is_draft, |d| d.child(div().ml(px(8.)).text_size(px(11.)).text_color(c(WARN)).child("Draft")))
                    .children(send_status(m.state).map(|s| s.ml(px(8.))))
                    .when(m.state == MessageState::Failed, |d| {
                        let (retry, edit) = (m.clone(), m.clone());
                        d.child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(2.))
                                .text_size(px(11.))
                                .text_color(c(STRONG))
                                .child(row_action(("retry", i), "Retry", false, Box::new(cx.listener(move |this, _, _, cx| this.retry_send(&retry, cx)))))
                                .child(row_action(
                                    ("edit", i),
                                    "Edit",
                                    false,
                                    Box::new(cx.listener(move |this, _, window, cx| {
                                        this.revert_to_draft(&edit, cx);
                                        this.open_compose(Some(edit.clone()), None, window, cx);
                                    })),
                                ))
                                .when_some(m.send_error.clone(), |d, e| d.child(div().ml(px(4.)).truncate().text_color(c(LABEL)).child(e))),
                        )
                    }),
            )
            .child(div().flex_shrink_0().text_size(px(12.)).text_color(c(LABEL)).child(short_date(m.date_ms)));

        let body: AnyElement = match &m.body_html {
            Some(html) => {
                let allow = self.thread().is_some_and(|t| t.images.contains(&key));
                let clean = sanitize_for_display(html, allow);
                let k = key.clone();
                div()
                    .when(clean.blocked_images > 0, |d| {
                        d.child(
                            div()
                                .mt(px(10.))
                                .flex()
                                .gap(px(4.))
                                .text_size(px(12.))
                                .text_color(c(LABEL))
                                .child("Images hidden ·")
                                .child(
                                    div()
                                        .id(("load-images", i))
                                        .cursor_pointer()
                                        .text_color(c(ACCENT))
                                        .hover(|s| s.text_color(c(ACCENT_LIGHT)))
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            // A draft's block opens the composer on click; this is not that
                                            cx.stop_propagation();
                                            if let Some(t) = this.thread_mut() {
                                                t.images.insert(k.clone());
                                            }
                                            cx.notify();
                                        }))
                                        .child("Load images"),
                                ),
                        )
                    })
                    .child(div().mt(px(10.)).child(html_view(("html", i), clean.html)))
                    .into_any_element()
            }
            None => {
                let text = if m.body_text.trim().is_empty() { &m.snippet } else { &m.body_text };
                div().mt(px(10.)).child(plain_body(text)).into_any_element()
            }
        };

        div()
            .flex()
            .gap(px(12.))
            .mt(px(22.))
            .when(!first, |d| d.border_t_1().border_color(c(LINE)).pt(px(20.)))
            .child(avatar(id.initials.clone(), if own { BUTTON_HOVER } else { id.color }, 28.))
            .child(div().min_w_0().flex_1().child(header).child(body))
            .into_any_element()
    }

    /// Older messages fold to one clickable line: sender + first body line
    fn collapsed_message(&mut self, i: usize, m: &WireMessage, cx: &mut Context<Self>) -> AnyElement {
        let id = self.contacts.resolve(&m.from);
        let own = self.is_own_address(&m.from.address);
        let key = message_key(m);
        let first_line = first_paragraph(if m.body_text.trim().is_empty() { &m.snippet } else { &m.body_text });
        div()
            .id(("collapsed", i))
            .mx(px(-12.))
            .mt(px(12.))
            .px(px(12.))
            .py(px(6.))
            .flex()
            .items_center()
            .gap(px(12.))
            .min_w_0()
            .rounded(px(8.))
            .cursor_pointer()
            .text_size(px(13.))
            .text_color(c(LABEL))
            .hover(|s| s.bg(c(ROW)).text_color(c(BODY)))
            .on_click(cx.listener(move |this, _, _, cx| {
                if let Some(t) = this.thread_mut() {
                    t.expanded.insert(key.clone());
                }
                cx.notify();
            }))
            .child(avatar(id.initials.clone(), if own { BUTTON_HOVER } else { id.color }, 28.).opacity(0.6))
            .child(div().flex_shrink_0().font_weight(FontWeight::SEMIBOLD).child(if own { "You".to_string() } else { id.name }))
            .child(div().min_w_0().flex_1().truncate().child(first_line))
            .child(div().flex_shrink_0().text_size(px(12.)).child(short_date(m.date_ms)))
            .into_any_element()
    }

    // ---------- reply composer ----------

    fn set_reply_mode(&mut self, mode: ReplyMode, window: &mut Window, cx: &mut Context<Self>) {
        let Some(t) = self.thread_mut() else { return };
        t.reply_mode = mode;
        if mode == ReplyMode::Collapsed {
            t.custom_height = None;
            window.focus(&self.focus, cx);
        } else {
            let reply = t.reply.clone();
            reply.update(cx, |s, cx| s.focus(window, cx));
        }
        cx.notify();
    }

    /// Escape steps down: slash menu → fullscreen → collapsed. True when consumed.
    pub fn reply_escape(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(t) = self.thread() else { return false };
        match t.reply_mode {
            ReplyMode::Collapsed => false,
            ReplyMode::Full => {
                self.set_reply_mode(ReplyMode::Open, window, cx);
                true
            }
            ReplyMode::Open => {
                let reply = t.reply.clone();
                if slash_active(reply.read(cx)) {
                    // Drop the lone "/" so the menu closes
                    editor::apply_slash(&reply, editor::EditOp::Paragraph, window, cx);
                    return true;
                }
                self.set_reply_mode(ReplyMode::Collapsed, window, cx);
                true
            }
        }
    }

    pub fn reply_send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(t) = self.thread() else { return };
        if t.reply_mode == ReplyMode::Collapsed {
            return;
        }
        let markdown = t.reply.read(cx).value().to_string();
        let messages = t.messages.clone();
        let reply = t.reply.clone();
        let Some((account_id, hdr)) = self.send_reply(&messages, &markdown, cx) else { return };
        reply.update(cx, |s, cx| s.set_value("", window, cx));
        if let Some(t) = self.thread_mut() {
            t.reply_text.clear();
        }
        self.set_reply_mode(ReplyMode::Collapsed, window, cx);
        let undo: Handler = Rc::new(move |this, window, cx| {
            this.unsend(account_id.clone(), hdr.clone(), cx);
            if let Some(t) = this.thread_mut() {
                let reply = t.reply.clone();
                reply.update(cx, |s, cx| s.set_value(markdown.clone(), window, cx));
                t.reply_text = markdown.clone();
            }
            this.set_reply_mode(ReplyMode::Open, window, cx);
        });
        self.show_toast("Message sent", Some(undo), cx);
    }

    fn render_reply(&mut self, label: String, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(t) = self.thread() else { return div().into_any_element() };
        let reply = t.reply.clone();
        if t.placeholder != label {
            let l = label.clone();
            reply.update(cx, |s, cx| s.set_placeholder(l, window, cx));
            if let Some(t) = self.thread_mut() {
                t.placeholder = label.clone();
            }
        }
        let Some(t) = self.thread() else { return div().into_any_element() };
        match t.reply_mode {
            ReplyMode::Collapsed => {
                let text = t.reply_text.clone();
                div()
                    .id("reply-pill")
                    .mt(px(36.))
                    .h(px(44.))
                    .w_full()
                    .flex()
                    .items_center()
                    .px(px(16.))
                    .rounded(px(22.))
                    .border_1()
                    .border_color(c(LINE_STRONG))
                    .bg(c(PILL))
                    .text_size(px(13.))
                    .text_color(c(META))
                    .cursor_pointer()
                    .hover(|s| s.bg(c(PILL_HOVER)))
                    .shadow(vec![BoxShadow { color: hsla(0., 0., 0., 0.25), offset: point(px(0.), px(4.)), blur_radius: px(15.), spread_radius: px(0.), inset: false, }])
                    .on_click(cx.listener(|this, _, window, cx| this.set_reply_mode(ReplyMode::Open, window, cx)))
                    .child(if text.trim().is_empty() {
                        div().child(label).into_any_element()
                    } else {
                        div()
                            .flex()
                            .min_w_0()
                            .gap(px(4.))
                            .child(div().text_color(c(WARN)).child("Draft"))
                            .child(div().min_w_0().truncate().child(format!("— {}", text.replace('\n', " "))))
                            .into_any_element()
                    })
                    .into_any_element()
            }
            ReplyMode::Open => div().mt(px(30.)).child(self.reply_card(false, cx)).into_any_element(),
            // Fullscreen renders as an overlay from the root (see reply_overlay)
            ReplyMode::Full => div().into_any_element(),
        }
    }

    /// Fullscreen reply, drawn over the whole window
    pub fn render_reply_overlay(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.thread()?.reply_mode != ReplyMode::Full || self.composer.is_some() {
            return None;
        }
        Some(
            div()
                .absolute()
                .inset_0()
                .flex()
                .flex_col()
                .items_center()
                .pt(px(28.))
                .pb(px(20.))
                .bg(c(BG))
                .occlude()
                .child(div().w(px(720.)).max_w(relative(0.92)).flex_1().min_h_0().flex().flex_col().child(self.reply_card(true, cx)))
                .into_any_element(),
        )
    }

    fn reply_card(&mut self, full: bool, cx: &mut Context<Self>) -> AnyElement {
        let Some(t) = self.thread() else { return div().into_any_element() };
        let reply = t.reply.clone();
        let text = t.reply_text.clone();
        let has_text = !text.trim().is_empty();
        let words = self.show_word_count.then(|| editor::word_count(&text));
        let custom = t.custom_height;
        let slash = slash_active(reply.read(cx));
        let corner = |id: &'static str, glyph: &'static str| {
            div()
                .id(id)
                .flex()
                .items_center()
                .justify_center()
                .h(px(24.))
                .w(px(26.))
                .rounded(px(5.))
                .cursor_pointer()
                .text_size(px(11.))
                .text_color(c(QUIET))
                .hover(|s| s.bg(ca(INK, 0.1)).text_color(c(INK)))
                .child(glyph)
        };

        let editor_box = div()
            .id("reply-editor")
            .overflow_y_scroll()
            .when(full, |d| d.flex_1().min_h_0())
            .when(!full, |d| match custom {
                Some(h) => d.h(h),
                None => d.min_h(px(110.)).max_h(relative(0.58)),
            })
            .child(editor_surface(&reply));

        div()
            .id("reply-card")
            .relative()
            .flex()
            .flex_col()
            .rounded(px(14.))
            .border_1()
            .border_color(c(EDGE))
            .bg(c(PANEL))
            .key_context("Compose")
            .when(full, |d| d.flex_1().min_h_0())
            .when(!full, |d| d.shadow(vec![BoxShadow { color: hsla(0., 0., 0., 0.25), offset: point(px(0.), px(4.)), blur_radius: px(15.), spread_radius: px(0.), inset: false, }]))
            // Drag-resize handle along the top edge
            .when(!full, |d| {
                d.child(
                    div()
                        .id("reply-drag")
                        .absolute()
                        .left_0()
                        .right(px(80.))
                        .top_0()
                        .h(px(10.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor(CursorStyle::ResizeUpDown)
                        .on_mouse_down(MouseButton::Left, cx.listener(|this, ev: &MouseDownEvent, _, cx| {
                            if let Some(t) = this.thread_mut() {
                                let start_h = t.custom_height.unwrap_or(px(160.));
                                t.drag = Some((ev.position.y, start_h));
                            }
                            cx.notify();
                        }))
                        .child(div().h(px(4.)).w(px(36.)).rounded_full().bg(ca(INK, 0.15))),
                )
            })
            .child(
                div()
                    .absolute()
                    .right(px(8.))
                    .top(px(6.))
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .child(corner("reply-full", if full { "⤡" } else { "⤢" }).on_click(cx.listener(move |this, _, window, cx| {
                        this.set_reply_mode(if full { ReplyMode::Open } else { ReplyMode::Full }, window, cx)
                    })))
                    .child(corner("reply-close", "✕").on_click(cx.listener(|this, _, window, cx| this.set_reply_mode(ReplyMode::Collapsed, window, cx)))),
            )
            .child(div().pl(px(10.)).pr(px(80.)).pt(px(12.)).pb(px(2.)).child(toolbar("reply-tb", &reply)))
            .child(
                div()
                    .relative()
                    .when(full, |d| d.flex_1().min_h_0().flex().flex_col())
                    .child(editor_box)
                    .when(slash, |d| d.child(div().absolute().left(px(16.)).top(px(36.)).child(slash_menu("reply-slash", &reply)))),
            )
            .child(
                div()
                    .flex()
                    .flex_shrink_0()
                    .items_center()
                    .gap(px(12.))
                    .border_t_1()
                    .border_color(c(LINE))
                    .px(px(14.))
                    .py(px(10.))
                    .child(
                        primary_button("reply-send", "Send", has_text, Box::new(cx.listener(|this, _, window, cx| this.reply_send(window, cx))))
                            .px(px(16.))
                            .py(px(6.))
                            .rounded(px(7.))
                            .text_size(px(12.)),
                    )
                    .child(quiet_button("reply-cancel", "Cancel", true, Box::new(cx.listener(|this, _, window, cx| this.set_reply_mode(ReplyMode::Collapsed, window, cx)))).text_size(px(12.)))
                    .child(spacer())
                    .child(div().text_size(px(11.)).text_color(c(HINT)).child(editor::hint(if has_text { words } else { None }))),
            )
            .into_any_element()
    }

    /// Mouse move/up while resizing the docked reply card
    pub fn reply_drag_move(&mut self, position: Point<Pixels>, window: &Window, cx: &mut Context<Self>) {
        let max = window.viewport_size().height - px(240.);
        if let Some(t) = self.thread_mut() {
            if let Some((start_y, start_h)) = t.drag {
                let h = (start_h + (start_y - position.y)).max(px(80.)).min(max);
                t.custom_height = Some(h);
                cx.notify();
            }
        }
    }

    pub fn reply_drag_end(&mut self, cx: &mut Context<Self>) {
        if let Some(t) = self.thread_mut() {
            if t.drag.take().is_some() {
                cx.notify();
            }
        }
    }

    pub fn reply_dragging(&self) -> bool {
        self.thread().is_some_and(|t| t.drag.is_some())
    }
}

fn first_paragraph(text: &str) -> String {
    text.split("\n\n").map(str::trim).find(|p| !p.is_empty()).unwrap_or("").replace('\n', " ")
}

/// text/plain body as paragraphs (blank lines separate; single newlines flow, as in the web view)
fn plain_body(text: &str) -> Div {
    let mut col = div().flex().flex_col().gap(px(10.)).text_size(px(14.)).line_height(px(23.8)).text_color(c(BODY));
    for p in text.split("\n\n").map(str::trim).filter(|p| !p.is_empty()) {
        col = col.child(div().child(p.replace('\n', " ")));
    }
    col
}

fn html_view(id: impl Into<ElementId>, html: String) -> impl IntoElement {
    let style = TextViewStyle::default()
        .with_foreground(c(BODY).into())
        .with_muted_foreground(c(QUIET).into())
        .with_link(c(ACCENT).into())
        .with_border(c(LINE_STRONG).into())
        .with_code_background(c(BG).into())
        .with_dark(true);
    div()
        .text_size(px(14.))
        .line_height(px(23.8))
        .text_color(c(BODY))
        .child(
            TextView::html(id, html)
                .style(style)
                .selectable(true)
                .on_link_click(|url, _, _, cx| {
                    // Mail HTML is attacker-controlled: only web links and mailto reach the OS
                    let lower = url.to_ascii_lowercase();
                    if lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:") {
                        cx.open_url(url);
                    } else {
                        log::warn!("dropped link: {url}");
                    }
                }),
        )
}
