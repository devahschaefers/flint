//! The window: drag band, the strip under the traffic lights, the current
//! page, and the overlays (outbox banner, composer, search, toast, menus).
//! Port of `App.tsx`, `Strip.tsx`, `Toast.tsx`, `OutboxBanner.tsx`.

use crate::app::*;
use crate::theme::*;
use crate::views::widgets::*;
use flint_core::{OpKind, OpState};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

impl Render for FlintApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.dev_open.is_some() {
            self.dev_open_pending(window, cx);
        }
        #[cfg(feature = "screenshots")]
        self.dev_schedule_shot(window, cx);
        let page = match &self.view {
            Screen::Thread(_) => self.render_thread(window, cx),
            Screen::Settings => self.render_settings(window, cx),
            _ => self.render_list(window, cx),
        };
        let menus_open = self.popover.is_some() || self.context_menu.is_some();

        div()
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::on_escape))
            .on_action(cx.listener(Self::on_open_search))
            .on_action(cx.listener(Self::on_open_search_slash))
            .on_action(cx.listener(Self::on_new_message))
            .on_action(cx.listener(Self::on_open_settings))
            .on_action(cx.listener(Self::on_go_pins))
            .on_action(cx.listener(Self::on_go_drafts))
            .on_action(cx.listener(Self::on_go_sent))
            .on_action(cx.listener(Self::on_send))
            .on_action(cx.listener(Self::on_search_up))
            .on_action(cx.listener(Self::on_search_down))
            .on_action(cx.listener(Self::on_search_enter))
            .when(self.reply_dragging(), |d| {
                d.on_mouse_move(cx.listener(|this, ev: &MouseMoveEvent, window, cx| this.reply_drag_move(ev.position, window, cx)))
                    .on_mouse_up(MouseButton::Left, cx.listener(|this, _, _, cx| this.reply_drag_end(cx)))
            })
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .bg(c(BG))
            .font_family(FONT)
            .text_size(px(14.))
            .text_color(c(STRONG))
            // No title bar: this band under the traffic lights drags the window
            .child(
                div()
                    .id("drag-band")
                    .h(px(30.))
                    .flex_shrink_0()
                    .on_mouse_down(MouseButton::Left, |ev, window, _| {
                        if ev.click_count >= 2 {
                            window.titlebar_double_click();
                        } else {
                            window.start_window_move();
                        }
                    }),
            )
            .child(div().relative().flex_1().min_h_0().child(page))
            .child(self.render_strip(cx))
            .children(self.render_outbox_banner(cx))
            .children(self.render_reply_overlay(cx))
            .children(self.render_composer(window, cx))
            .children(self.render_search(window, cx))
            .children(self.render_toast(cx))
            .when(menus_open, |d| {
                d.child(
                    div()
                        .id("menu-backdrop")
                        .absolute()
                        .inset_0()
                        .occlude()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, _, cx| {
                                this.popover = None;
                                this.context_menu = None;
                                cx.notify();
                            }),
                        )
                        .on_mouse_down(
                            MouseButton::Right,
                            cx.listener(|this, _, _, cx| {
                                this.popover = None;
                                this.context_menu = None;
                                cx.notify();
                            }),
                        ),
                )
            })
            .children(self.render_context_menu(cx))
    }
}

impl FlintApp {
    /// Account filter, search, compose: the quiet column under the traffic lights
    fn render_strip(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let glyph = |id: &'static str, icon: &'static str, active: bool| {
            div()
                .id(id)
                .relative()
                .flex()
                .items_center()
                .justify_center()
                .size(px(28.))
                .rounded(px(7.))
                .cursor_pointer()
                .text_color(c(if active { MUTED } else { LABEL }))
                .when(active, |d| d.bg(c(HOVER)))
                .hover(|s| s.bg(c(HOVER)).text_color(c(MUTED)))
                .child(svg().path(icon).size(px(15.)).text_color(c(if active { MUTED } else { LABEL })))
        };
        let filter_open = self.popover == Some(Popover::Filter);
        let filter_active = self.active_account.is_some();

        div()
            .absolute()
            .left(px(18.))
            .top(px(52.))
            .flex()
            .flex_col()
            .items_center()
            .gap(px(6.))
            .when(self.accounts.len() > 1, |d| {
                d.child(
                    div()
                        .relative()
                        .child(
                            glyph("strip-filter", "icons/filter.svg", filter_open)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.set_popover((!filter_open).then_some(Popover::Filter), cx)
                                }))
                                .when(filter_active, |d| {
                                    d.child(
                                        div()
                                            .absolute()
                                            .right(px(3.))
                                            .top(px(3.))
                                            .size(px(6.))
                                            .rounded_full()
                                            .bg(c(ACCENT)),
                                    )
                                }),
                        )
                        .when(filter_open, |d| d.child(self.render_filter_popover(cx))),
                )
            })
            .child(
                glyph("strip-search", "icons/search.svg", false)
                    .on_click(cx.listener(|this, _, window, cx| this.open_search(window, cx))),
            )
            .when(self.connected(), |d| {
                d.child(
                    glyph("strip-compose", "icons/compose.svg", false).on_click(cx.listener(
                        |this, _, window, cx| {
                            if this.composer.is_none() {
                                this.open_compose(None, None, window, cx)
                            }
                        },
                    )),
                )
            })
    }

    fn render_filter_popover(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let active = self.active_account.clone();
        let mut panel = popover_panel(220.)
            .child(popover_label("Filter"))
            .child(
                popover_item("filter-all", active.is_none(), Box::new(cx.listener(|this, _, w, cx| this.set_account(None, w, cx))))
                    .child(dot(None))
                    .child("All accounts")
                    .child(spacer())
                    .when(active.is_none(), |d| d.child(check())),
            );
        for (i, a) in self.accounts.iter().enumerate() {
            let id = a.id.clone();
            let on = active.as_deref() == Some(a.id.as_str());
            panel = panel.child(
                popover_item(("filter-acct", i), on, Box::new(cx.listener(move |this, _, w, cx| this.set_account(Some(id.clone()), w, cx))))
                    .child(dot(Some(parse_hex(&a.color))))
                    .child(div().truncate().child(a.email.clone()))
                    .child(spacer())
                    .when(on, |d| d.child(check())),
            );
        }
        div()
            .absolute()
            .left(px(36.))
            .top(px(0.))
            .child(deferred(anchored().snap_to_window_with_margin(px(12.)).child(panel)).with_priority(1))
    }

    fn render_toast(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let toast = self.toast.as_ref()?;
        // Sit above the outbox banner when both are up
        let lifted = self.outbox.iter().any(|op| op.kind != OpKind::Send);
        let undo = toast.undo.clone();
        Some(
            div()
                .absolute()
                .bottom(px(if lifted { 74. } else { 26. }))
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .child(
                    pill()
                        .occlude()
                        .child(toast.text.clone())
                        .when_some(undo, |d, undo| {
                            d.child(pill_button(
                                "toast-undo",
                                "Undo",
                                true,
                                Box::new(cx.listener(move |this, _, window, cx| {
                                    undo(this, window, cx);
                                    this.dismiss_toast(cx);
                                })),
                            ))
                        }),
                )
                .into_any_element(),
        )
    }

    /// Outbox operations that could not reach Gmail (label actions and drafts;
    /// sends have their own inline Retry / Edit)
    fn render_outbox_banner(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let ops: Vec<_> = self.outbox.iter().filter(|op| op.kind != OpKind::Send).collect();
        if ops.is_empty() {
            return None;
        }
        let parked = ops.iter().filter(|op| op.state == OpState::Failed).count();
        let retrying = ops.len() - parked;
        let plural = |n: usize| if n == 1 { "change" } else { "changes" };
        let summary = if parked > 0 {
            format!("{parked} {} couldn't sync to Gmail", plural(parked))
        } else {
            format!("{retrying} {} waiting to sync", plural(retrying))
        };
        Some(
            div()
                .absolute()
                .bottom(px(26.))
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .child(
                    pill()
                        .occlude()
                        .child(div().size(px(6.)).rounded_full().bg(c(if parked > 0 { DANGER } else { WARN })))
                        .child(summary)
                        .child(pill_button("outbox-retry", "Retry", true, Box::new(cx.listener(|this, _, _, cx| this.retry_outbox(cx)))))
                        .child(pill_button("outbox-discard", "Discard", false, Box::new(cx.listener(|this, _, _, cx| this.discard_outbox(cx))))),
                )
                .into_any_element(),
        )
    }

    fn render_context_menu(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let menu = self.context_menu.as_ref()?;
        let mut panel = popover_panel(190.).text_color(c(MUTED));
        for (i, entry) in menu.entries.iter().enumerate() {
            panel = match entry {
                MenuEntry::Separator => panel.child(popover_divider()),
                MenuEntry::Item(label, handler) => {
                    let handler = handler.clone();
                    panel.child(
                        popover_item(
                            ("ctx", i),
                            false,
                            Box::new(cx.listener(move |this, _, window, cx| {
                                this.context_menu = None;
                                handler(this, window, cx);
                                cx.notify();
                            })),
                        )
                        .gap(px(8.))
                        .child(label.clone()),
                    )
                }
            };
        }
        Some(
            deferred(
                anchored()
                    .position(menu.position)
                    .snap_to_window_with_margin(px(8.))
                    .child(panel),
            )
            .with_priority(2)
            .into_any_element(),
        )
    }

    pub fn show_context_menu(&mut self, position: Point<Pixels>, entries: Vec<MenuEntry>, cx: &mut Context<Self>) {
        self.popover = None;
        self.context_menu = Some(ContextMenu { position, entries });
        cx.notify();
    }
}

/// "#4E9BF5" → 0x4e9bf5 (account colors are stored as CSS hex)
pub fn parse_hex(s: &str) -> u32 {
    u32::from_str_radix(s.trim_start_matches('#'), 16).unwrap_or(0x3a3a3a)
}
