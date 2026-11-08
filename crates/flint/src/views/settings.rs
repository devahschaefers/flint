//! Settings: accounts (add via browser sign-in, remove, sync progress),
//! preferences, signature, about.

use crate::app::*;
use crate::theme::*;
use crate::views::root::parse_hex;
use crate::views::widgets::*;
use flint_core::*;
use gpui_kit::base::input::{InputEvent, TextareaState};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use crate::zoom::px;
use std::time::Duration;

pub struct SettingsState {
    pub signature: Entity<TextareaState>,
    pub status: Vec<SyncStatus>,
    pub busy: bool,
    pub error: Option<String>,
    _poll: Option<Task<()>>,
    _subs: Vec<Subscription>,
}

fn initials_of(name: &str) -> String {
    let s: String = name.split_whitespace().take(2).filter_map(|p| p.chars().next()).flat_map(char::to_uppercase).collect();
    if s.is_empty() {
        "?".into()
    } else {
        s
    }
}

impl SettingsState {
    pub fn new(app: &FlintApp, window: &mut Window, cx: &mut Context<FlintApp>) -> Self {
        let value = app.signature.clone();
        let signature = cx.new(|cx| {
            let mut s = TextareaState::new(window, cx).placeholder("— Your name").auto_grow(2, 8);
            s.set_value(value, window, cx);
            s
        });
        let sub = cx.subscribe_in(&signature, window, |this: &mut FlintApp, state, ev: &InputEvent, _, cx| {
            if let InputEvent::Change = ev {
                let v = state.read(cx).value().to_string();
                if v != this.signature {
                    this.signature = v.clone();
                    this.persist_setting(SETTING_SIGNATURE, v, cx);
                }
            }
        });
        SettingsState { signature, status: Vec::new(), busy: false, error: None, _poll: None, _subs: vec![sub] }
    }
}

impl FlintApp {
    /// Poll backfill progress every 3 s while settings is open
    pub fn start_status_poll(&mut self, cx: &mut Context<Self>) {
        let task = cx.spawn(async move |this, cx| loop {
            let Ok(engine) = this.update(cx, |this, _| this.engine.clone()) else { break };
            let status = cx.background_spawn(async move { engine.sync_status() }).await;
            let alive = this
                .update(cx, |this, cx| {
                    if let PageState::Settings(s) = &mut this.page {
                        if let Ok(status) = status {
                            s.status = status;
                        }
                        cx.notify();
                        true
                    } else {
                        false
                    }
                })
                .unwrap_or(false);
            if !alive {
                break;
            }
            cx.background_executor().timer(Duration::from_secs(3)).await;
        });
        if let PageState::Settings(s) = &mut self.page {
            s._poll = Some(task);
        }
    }

    fn add_account(&mut self, cx: &mut Context<Self>) {
        let PageState::Settings(s) = &mut self.page else { return };
        if s.busy {
            return;
        }
        s.busy = true;
        s.error = None;
        self.bg(
            cx,
            |engine| engine.add_account(),
            |this, result, cx| {
                if let PageState::Settings(s) = &mut this.page {
                    s.busy = false;
                    if let Err(err) = &result {
                        s.error = Some(format!("{err:#}"));
                    }
                }
                if result.is_ok() {
                    this.init(cx);
                }
            },
        );
    }

    fn remove_account(&mut self, id: String, cx: &mut Context<Self>) {
        self.bg(
            cx,
            move |engine| engine.remove_account(&id),
            |this, result, cx| {
                if let Err(err) = result {
                    log::error!("remove account failed: {err:#}");
                }
                this.init(cx);
            },
        );
    }

    pub fn render_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let PageState::Settings(s) = &self.page else { return div().into_any_element() };
        let (status, busy, error, signature) = (s.status.clone(), s.busy, s.error.clone(), s.signature.clone());
        let connected = self.connected();
        let label = |t: &'static str| div().mt(px(24.)).mb(px(6.)).text_size(px(11.)).text_color(c(LABEL)).child(t);
        let row = || div().flex().items_center().py(px(9.));
        let _ = window;

        let mut accounts = div();
        for (i, a) in self.accounts.iter().enumerate() {
            let st = status.iter().find(|s| s.account_id == a.id);
            let id = a.id.clone();
            accounts = accounts.child(
                div()
                    .id(("settings-acct", i))
                    .group("acct")
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .py(px(9.))
                    .child(avatar(initials_of(&a.name), parse_hex(&a.color), 26.))
                    .child(div().truncate().text_size(px(13.5)).text_color(c(STRONG)).child(a.name.clone()))
                    .child(spacer())
                    .child(div().truncate().text_size(px(12.)).text_color(c(META)).child(a.email.clone()))
                    .when_some(st, |d, st| {
                        d.child(
                            div()
                                .flex_shrink_0()
                                .text_size(px(12.))
                                .text_color(c(LABEL))
                                .child(format!("{} {}", group_thousands(st.message_count), if st.backfill_done { "synced" } else { "syncing…" })),
                        )
                    })
                    .child(
                        div()
                            .id(("remove-acct", i))
                            .my(px(-4.))
                            .rounded(px(5.))
                            .px(px(6.))
                            .py(px(2.))
                            .text_size(px(12.))
                            .text_color(c(LABEL))
                            .cursor_pointer()
                            .invisible()
                            .group_hover("acct", |s| s.visible())
                            .hover(|s| s.bg(c(HOVER)).text_color(c(DANGER)))
                            .on_click(cx.listener(move |this, _, _, cx| this.remove_account(id.clone(), cx)))
                            .child("✕"),
                    ),
            );
        }

        let add = div()
            .id("add-gmail")
            .mx(px(-12.))
            .px(px(12.))
            .py(px(9.))
            .flex()
            .items_center()
            .gap(px(8.))
            .rounded(px(8.))
            .text_size(px(13.))
            .text_color(c(if busy { LABEL } else { ACCENT }))
            .when(!busy, |d| d.cursor_pointer().hover(|s| s.bg(c(ROW))).on_click(cx.listener(|this, _, _, cx| this.add_account(cx))))
            .when(busy, |d| d.child(spinner()).child("Waiting for Google sign-in in your browser…"))
            .when(!busy, |d| d.child("+ Add Gmail account"));

        let prefs = div()
            .child(
                row()
                    .child(div().text_size(px(13.5)).text_color(c(STRONG)).child("Hide done emails"))
                    .child(spacer())
                    .child(toggle("toggle-hide-done", self.hide_done, Box::new(cx.listener(|this, _, w, cx| this.toggle_hide_done(w, cx))))),
            )
            .child(
                row()
                    .child(div().text_size(px(13.5)).text_color(c(STRONG)).child("Show word count while composing"))
                    .child(spacer())
                    .child(toggle("toggle-words", self.show_word_count, Box::new(cx.listener(|this, _, _, cx| this.toggle_word_count(cx))))),
            )
            .child(div().pt(px(9.)).pb(px(4.)).text_size(px(13.5)).text_color(c(STRONG)).child("Signature"))
            .child(
                div()
                    .min_h(px(44.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(c(LINE_STRONG))
                    .px(px(12.))
                    .py(px(10.))
                    .text_size(px(13.))
                    .line_height(px(21.))
                    .text_color(c(DIM))
                    .child(gpui_kit::base::Textarea::new(&signature)),
            );

        let content = div()
            .child(self.back_link(cx))
            .child(div().mt(px(18.)).text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).text_color(c(INK)).child("Settings"))
            .child(
                div()
                    .max_w(px(640.))
                    .child(label("Accounts"))
                    .child(accounts)
                    .child(add)
                    .when_some(error, |d, e| d.child(div().py(px(8.)).text_size(px(12.)).text_color(c(DANGER)).child(e)))
                    .when(!connected && !busy, |d| {
                        d.child(div().py(px(4.)).text_size(px(12.)).text_color(c(LABEL)).child("No account connected yet — add your Gmail to start syncing."))
                    })
                    .child(label("Preferences"))
                    .child(prefs)
                    .child(label("About"))
                    .child(
                        div()
                            .py(px(9.))
                            .text_size(px(12.))
                            .text_color(c(META))
                            .child(format!("Flint · v{} · {}", env!("CARGO_PKG_VERSION"), if connected { "live Gmail data" } else { "no account connected" })),
                    ),
            );
        self.page("page-settings", true, content)
    }
}

fn group_thousands(n: i64) -> String {
    let s = n.abs().to_string();
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    if n < 0 {
        format!("-{out}")
    } else {
        out
    }
}
