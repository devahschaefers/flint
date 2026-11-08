//! New Message: a full window with one card, opened from the strip (⌘N), a
//! draft, or search's "Compose to …". Closing saves a draft when anything was
//! typed, or deletes the draft when every field was cleared. Port of
//! ComposerModal.tsx.

use crate::app::*;
use crate::theme::*;
use crate::util::identity::{format_address_list, parse_address_list};
use crate::util::mailhtml::html_to_markdown;
use crate::views::editor::{self, editor_surface, slash_active, slash_menu, toolbar};
use crate::views::root::parse_hex;
use crate::views::widgets::*;
use flint_core::*;
use gpui_kit::base::input::{InputEvent, InputState, TextareaState};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

pub struct ComposerState {
    /// The draft being edited; None for a new message
    pub draft: Option<WireMessage>,
    pub to: Entity<InputState>,
    pub subject: Entity<InputState>,
    pub body: Entity<TextareaState>,
    pub account_id: String,
    pub from_menu: bool,
    to_text: String,
    subject_text: String,
    body_text: String,
    _subs: Vec<Subscription>,
}

impl ComposerState {
    fn has_content(&self) -> bool {
        !self.to_text.trim().is_empty() || !self.subject_text.trim().is_empty() || !self.body_text.trim().is_empty()
    }

    fn recipients(&self) -> Vec<Mailbox> {
        parse_address_list(&self.to_text)
    }
}

fn input_with(window: &mut Window, cx: &mut Context<FlintApp>, placeholder: &'static str, value: String) -> Entity<InputState> {
    cx.new(|cx| {
        let mut s = InputState::new(window, cx).placeholder(placeholder);
        s.set_value(value, window, cx);
        s
    })
}

impl FlintApp {
    /// Open the composer: blank, editing `draft`, or prefilled with a recipient
    pub fn open_compose(&mut self, draft: Option<WireMessage>, prefill_to: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        if !self.connected() {
            return;
        }
        self.popover = None;
        self.context_menu = None;
        let (to, subject, body, account_id) = match &draft {
            Some(d) => (
                format_address_list(&d.to),
                if d.subject == "(no subject)" { String::new() } else { d.subject.clone() },
                d.body_html.as_deref().map(html_to_markdown).unwrap_or_else(|| d.body_text.clone()),
                d.account_id.clone(),
            ),
            None => (
                prefill_to.unwrap_or_default(),
                String::new(),
                String::new(),
                self.active_account.clone().or_else(|| self.accounts.first().map(|a| a.id.clone())).unwrap_or_default(),
            ),
        };
        let to_state = input_with(window, cx, "To", to.clone());
        let subject_state = input_with(window, cx, "Subject", subject.clone());
        let body_state = cx.new(|cx| {
            let mut s = TextareaState::new(window, cx).placeholder("Write something...");
            s.set_value(body.clone(), window, cx);
            s
        });

        let mut subs = Vec::new();
        for (state, field) in [(to_state.clone(), 0u8), (subject_state.clone(), 1u8)] {
            subs.push(cx.subscribe_in(&state, window, move |this: &mut FlintApp, s, ev: &InputEvent, _, cx| {
                if let (InputEvent::Change, Some(comp)) = (ev, this.composer.as_mut()) {
                    let v = s.read(cx).value().to_string();
                    if field == 0 {
                        comp.to_text = v;
                    } else {
                        comp.subject_text = v;
                    }
                    cx.notify();
                }
            }));
        }
        subs.push(cx.subscribe_in(&body_state, window, |this: &mut FlintApp, s, ev: &InputEvent, _, cx| {
            if let (InputEvent::Change, Some(comp)) = (ev, this.composer.as_mut()) {
                comp.body_text = s.read(cx).value().to_string();
                cx.notify();
            }
        }));

        // Focus the first empty field
        if to.is_empty() {
            to_state.update(cx, |s, cx| s.focus(window, cx));
        } else if subject.is_empty() {
            subject_state.update(cx, |s, cx| s.focus(window, cx));
        } else {
            body_state.update(cx, |s, cx| s.focus(window, cx));
        }

        self.composer = Some(ComposerState {
            draft,
            to: to_state,
            subject: subject_state,
            body: body_state,
            account_id,
            from_menu: false,
            to_text: to,
            subject_text: subject,
            body_text: body,
            _subs: subs,
        });
        cx.notify();
    }

    fn close_composer_ui(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.composer = None;
        window.focus(&self.focus, cx);
        cx.notify();
    }

    /// ✕ / Escape: save when anything was typed, delete a draft that was emptied
    pub fn composer_close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(comp) = &self.composer else { return };
        if comp.from_menu {
            if let Some(comp) = self.composer.as_mut() {
                comp.from_menu = false;
            }
            cx.notify();
            return;
        }
        if slash_active(comp.body.read(cx)) {
            let body = comp.body.clone();
            editor::apply_slash(&body, editor::EditOp::Paragraph, window, cx);
            return;
        }
        if comp.has_content() {
            self.composer_save_draft(window, cx);
        } else {
            if let Some(d) = &comp.draft {
                self.delete_draft(d.account_id.clone(), d.message_id_hdr.clone().unwrap_or_default(), cx);
            }
            self.close_composer_ui(window, cx);
        }
    }

    pub fn composer_save_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(comp) = &self.composer else { return };
        if !comp.has_content() {
            return;
        }
        let input = self.composed_input(&comp.to_text, &comp.subject_text, &comp.body_text, &comp.account_id, comp.draft.as_ref(), false);
        self.close_composer_ui(window, cx);
        if let Some(input) = input {
            self.run(cx, "save draft", move |engine| engine.save_draft(input).map(|_| ()));
        }
    }

    pub fn composer_send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(comp) = &self.composer else { return };
        if !comp.has_content() || comp.recipients().is_empty() {
            return;
        }
        let Some(input) = self.composed_input(&comp.to_text, &comp.subject_text, &comp.body_text, &comp.account_id, comp.draft.as_ref(), true) else {
            return;
        };
        let toast = match input.to.first() {
            Some(first) => format!("Message sent to {}", first.name.clone().unwrap_or_else(|| first.address.clone())),
            None => "Message sent".into(),
        };
        self.close_composer_ui(window, cx);
        // Composer sends go out immediately (the reply toast's Undo is the delayed path)
        self.run(cx, "send", move |engine| engine.queue_send(input, now_ms()).map(|_| ()));
        self.show_toast(toast, None, cx);
    }

    pub fn render_composer(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let comp = self.composer.as_ref()?;
        let account = self.account(&comp.account_id).or(self.accounts.first())?.clone();
        let contacts = self.contacts.clone();
        let recipients = comp.recipients();
        let can_send = comp.has_content() && !recipients.is_empty();
        let has_content = comp.has_content();
        let title = comp.draft.as_ref().map(|d| d.subject.clone()).unwrap_or_else(|| "New Message".into());
        let locked_from = comp.draft.as_ref().is_some_and(|d| d.in_reply_to.is_some()) || self.accounts.len() < 2;
        let from_menu = comp.from_menu;
        let (to, subject, body) = (comp.to.clone(), comp.subject.clone(), comp.body.clone());
        let slash = slash_active(body.read(cx));

        let field_row = |content: AnyElement| div().flex_shrink_0().border_b_1().border_color(c(LINE)).px(px(16.)).child(content);
        let input_box = |state: &Entity<InputState>| {
            div().h(px(40.)).flex().items_center().text_size(px(13.)).text_color(c(STRONG)).child(gpui_kit::base::Input::new(state))
        };

        let from_label = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .min_w_0()
            .text_color(c(STRONG))
            .child(div().size(px(10.)).flex_shrink_0().rounded_full().bg(c(parse_hex(&account.color))))
            .child(div().truncate().child(account.name.clone()))
            .child(div().truncate().text_color(c(LABEL)).child(format!("· {}", account.email)));

        let from_row = div()
            .flex_shrink_0()
            .h(px(40.))
            .flex()
            .items_center()
            .gap(px(12.))
            .border_b_1()
            .border_color(c(LINE))
            .px(px(16.))
            .text_size(px(13.))
            .child(div().text_color(c(LABEL)).child("From"))
            .child(if locked_from {
                // A reply draft stays on the account that owns its thread
                from_label.into_any_element()
            } else {
                div()
                    .relative()
                    .child(
                        div()
                            .id("from-picker")
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .cursor_pointer()
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Some(c) = this.composer.as_mut() {
                                    c.from_menu = !c.from_menu;
                                }
                                cx.notify();
                            }))
                            .child(from_label)
                            .child(div().text_size(px(11.)).text_color(c(LABEL)).child("▾")),
                    )
                    .when(from_menu, |d| {
                        let mut panel = popover_panel(220.).text_color(c(MUTED));
                        for (i, a) in self.accounts.iter().enumerate() {
                            let id = a.id.clone();
                            panel = panel.child(
                                popover_item(("from-acct", i), false, Box::new(cx.listener(move |this, _, _, cx| {
                                    if let Some(c) = this.composer.as_mut() {
                                        c.account_id = id.clone();
                                        c.from_menu = false;
                                    }
                                    cx.notify();
                                })))
                                .child(dot(Some(parse_hex(&a.color))))
                                .child(div().truncate().child(a.email.clone())),
                            );
                        }
                        d.child(div().absolute().top(px(26.)).left_0().child(deferred(anchored().child(panel)).with_priority(3)))
                    })
                    .into_any_element()
            });

        let chips = (!recipients.is_empty()).then(|| {
            div().flex().flex_wrap().gap(px(6.)).pb(px(10.)).children(recipients.iter().map(|m| {
                let id = contacts.resolve(m);
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .rounded_full()
                    .bg(c(LINE))
                    .py(px(3.))
                    .pl(px(6.))
                    .pr(px(10.))
                    .text_size(px(11.))
                    .text_color(c(BRIGHT))
                    .child(avatar(id.initials.clone(), id.color, 16.))
                    .child(id.name)
            }))
        });

        let card = div()
            .id("composer-card")
            .key_context("Compose")
            .relative()
            .w(px(720.))
            .max_w(relative(0.92))
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .rounded(px(14.))
            .border_1()
            .border_color(c(EDGE))
            .bg(c(PANEL))
            .shadow(vec![BoxShadow { color: hsla(0., 0., 0., 0.55), offset: point(px(0.), px(24.)), blur_radius: px(70.), spread_radius: px(0.), inset: false, }])
            .child(
                div()
                    .flex()
                    .flex_shrink_0()
                    .items_center()
                    .justify_between()
                    .px(px(16.))
                    .pt(px(14.))
                    .pb(px(6.))
                    .child(div().truncate().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).text_color(c(INK)).child(title))
                    .child(
                        div()
                            .id("composer-close")
                            .cursor_pointer()
                            .text_size(px(13.))
                            .text_color(c(QUIET))
                            .hover(|s| s.text_color(c(INK)))
                            .on_click(cx.listener(|this, _, window, cx| this.composer_close(window, cx)))
                            .child("✕"),
                    ),
            )
            .child(from_row)
            .child(field_row(div().child(input_box(&to)).children(chips).into_any_element()))
            .child(field_row(input_box(&subject).into_any_element()))
            .child(div().flex_shrink_0().border_b_1().border_color(c(LINE)).px(px(10.)).pt(px(8.)).pb(px(4.)).child(toolbar("compose-tb", &body)))
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h(px(180.))
                    .child(div().id("compose-editor").size_full().overflow_y_scroll().pt(px(6.)).child(editor_surface(&body)))
                    .when(slash, |d| d.child(div().absolute().left(px(16.)).top(px(36.)).child(slash_menu("compose-slash", &body)))),
            )
            .child(
                div()
                    .flex()
                    .flex_shrink_0()
                    .items_center()
                    .gap(px(14.))
                    .border_t_1()
                    .border_color(c(LINE))
                    .px(px(16.))
                    .pt(px(12.))
                    .pb(px(16.))
                    .child(primary_button("compose-send", "Send", can_send, Box::new(cx.listener(|this, _, window, cx| this.composer_send(window, cx)))))
                    .child(quiet_button("compose-save", "Save draft", has_content, Box::new(cx.listener(|this, _, window, cx| this.composer_save_draft(window, cx)))))
                    .child(spacer())
                    .child(div().text_size(px(11.)).text_color(c(HINT)).child(editor::hint(None))),
            );

        Some(
            div()
                .id("composer")
                .absolute()
                .inset_0()
                .flex()
                .flex_col()
                .items_center()
                .pt(px(28.))
                .pb(px(20.))
                .bg(c(BG))
                .occlude()
                .child(card)
                .into_any_element(),
        )
    }
}
