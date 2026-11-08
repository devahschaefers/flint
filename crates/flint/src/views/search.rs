//! ⌘K: full-text search over every folder (FTS5 in the store, best match
//! first), keyboard-first, with a "Compose to …" shortcut. Every open starts
//! empty.

use crate::app::*;
use crate::theme::*;
use crate::util::dates::short_date;
use crate::util::identity::{format_mailbox, is_valid_address, normalize_subject};
use crate::views::widgets::*;
use flint_core::*;
use gpui_kit::base::input::{InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use crate::zoom::px;
use std::time::Duration;

const MIN_QUERY: usize = 2;
const DEBOUNCE_MS: u64 = 120;
/// Few enough that the Actions row stays in view under the list
const RESULT_LIMIT: usize = 8;

pub struct SearchState {
    pub input: Entity<InputState>,
    /// The typed value once typing pauses
    pub settled: String,
    pub results: Vec<SearchResult>,
    pub selected: usize,
    pub loading: bool,
    /// The results list; its children are the "Conversations" label, then one per row
    scroll: ScrollHandle,
    seq: u64,
    _debounce: Option<Task<()>>,
    _subs: Vec<Subscription>,
}

impl FlintApp {
    pub fn open_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.popover = None;
        self.context_menu = None;
        if let Some(s) = &self.search {
            let input = s.input.clone();
            input.update(cx, |s, cx| s.focus(window, cx));
            return;
        }
        let placeholder = if self.connected() { "Search mail…" } else { "No account connected" };
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
        let sub = cx.subscribe_in(&input, window, |this: &mut FlintApp, state, ev: &InputEvent, _, cx| {
            if !matches!(ev, InputEvent::Change) {
                return;
            }
            let query = state.read(cx).value().trim().to_string();
            let Some(search) = this.search.as_mut() else { return };
            search.selected = 0;
            search._debounce = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(Duration::from_millis(DEBOUNCE_MS)).await;
                this.update(cx, |this, cx| this.run_search(query, cx)).ok();
            }));
            cx.notify();
        });
        input.update(cx, |s, cx| s.focus(window, cx));
        self.search = Some(SearchState {
            input,
            settled: String::new(),
            results: Vec::new(),
            selected: 0,
            loading: false,
            scroll: ScrollHandle::new(),
            seq: 0,
            _debounce: None,
            _subs: vec![sub],
        });
        cx.notify();
    }

    pub fn close_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.search = None;
        // Hand focus back to whatever sits underneath
        if let Some(comp) = &self.composer {
            let body = comp.body.clone();
            body.update(cx, |s, cx| s.focus(window, cx));
        } else {
            window.focus(&self.focus, cx);
        }
        cx.notify();
    }

    pub fn run_search(&mut self, query: String, cx: &mut Context<Self>) {
        let scope = self.scope();
        let connected = self.connected();
        let Some(search) = self.search.as_mut() else { return };
        search.settled = query.clone();
        search.seq += 1;
        let seq = search.seq;
        if query.chars().count() < MIN_QUERY || !connected {
            search.results.clear();
            search.loading = false;
            cx.notify();
            return;
        }
        search.loading = true;
        self.bg(
            cx,
            move |engine| engine.store().search_threads(&query, scope.as_deref(), RESULT_LIMIT),
            move |this, result, _| {
                let Some(search) = this.search.as_mut() else { return };
                if search.seq != seq {
                    return;
                }
                search.loading = false;
                match result {
                    Ok(results) => {
                        search.selected = search.selected.min(results.len().saturating_sub(1));
                        search.results = results;
                    }
                    Err(err) => log::error!("search failed: {err:#}"),
                }
            },
        );
    }

    /// To the top result's counterpart, or to a typed address
    pub fn compose_target(&self) -> Option<(String, String)> {
        let search = self.search.as_ref()?;
        if let Some(top) = search.results.first().and_then(|r| r.thread.counterpart.clone()) {
            let name = self.contacts.resolve(&top).name;
            return Some((format_mailbox(&top), name));
        }
        is_valid_address(&search.settled).then(|| (search.settled.clone(), search.settled.clone()))
    }

    fn search_open_result(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(r) = self.search.as_ref().and_then(|s| s.results.get(ix)).map(|r| r.thread.thread_ref()) else { return };
        self.close_search(window, cx);
        // The composer fills the window, so it has to go for the thread to show
        if self.composer_put_away(window, cx) {
            self.show_toast("Saved to Drafts", None, cx);
        }
        self.open_thread(r, window, cx);
    }

    pub fn search_compose(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((to, _)) = self.compose_target() else { return };
        self.close_search(window, cx);
        if self.composer.is_none() {
            self.open_compose(None, Some(to), window, cx);
        }
    }

    pub fn on_search_up(&mut self, _: &SearchUp, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(s) = self.search.as_mut() {
            s.selected = s.selected.saturating_sub(1);
            s.scroll.scroll_to_item(s.selected + 1);
            cx.notify();
        }
    }

    pub fn on_search_down(&mut self, _: &SearchDown, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(s) = self.search.as_mut() {
            s.selected = (s.selected + 1).min(s.results.len().saturating_sub(1));
            s.scroll.scroll_to_item(s.selected + 1);
            cx.notify();
        }
    }

    pub fn on_search_enter(&mut self, _: &SearchEnter, window: &mut Window, cx: &mut Context<Self>) {
        let Some(s) = self.search.as_ref() else {
            cx.propagate();
            return;
        };
        if s.results.is_empty() {
            self.search_compose(window, cx);
        } else {
            let ix = s.selected;
            self.search_open_result(ix, window, cx);
        }
    }

    pub fn render_search(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let search = self.search.as_ref()?;
        let input = search.input.clone();
        let settled = search.settled.clone();
        let active = settled.chars().count() >= MIN_QUERY;
        let results = search.results.clone();
        let selected = search.selected.min(results.len().saturating_sub(1));
        let loading = search.loading;
        let compose = self.compose_target();
        let contacts = self.contacts.clone();
        let cap = |s: &str| div().px(px(18.)).pt(px(8.)).pb(px(2.)).text_size(px(10.)).text_color(c(HINT)).child(s.to_uppercase());

        let mut list = div().id("search-results").min_h_0().overflow_y_scroll().restrict_scroll_to_axis().track_scroll(&search.scroll);
        if active && !results.is_empty() {
            list = list.child(cap("Conversations"));
            let n = results.len();
            for (i, r) in results.iter().enumerate() {
                let t = &r.thread;
                let mailbox = t.counterpart.clone().or_else(|| t.latest.to.first().cloned()).unwrap_or_else(|| t.latest.from.clone());
                let id = contacts.resolve(&mailbox);
                let current = i == selected;
                let subject = Some(normalize_subject(if r.matched.subject.is_empty() { &t.subject } else { &r.matched.subject }))
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "(no subject)".into());
                list = list.child(div().px(px(10.)).when(i + 1 == n, |d| d.pb(px(8.))).child(
                    div()
                        .id(("search-row", i))
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .rounded(px(7.))
                        .px(px(10.))
                        .py(px(7.))
                        .cursor_pointer()
                        .when(current, |d| d.bg(c(HOVER_STRONG)))
                        .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                            if *hovered {
                                if let Some(s) = this.search.as_mut() {
                                    s.selected = i;
                                    cx.notify();
                                }
                            }
                        }))
                        .on_click(cx.listener(move |this, _, window, cx| this.search_open_result(i, window, cx)))
                        .child(avatar(id.initials.clone(), id.color, 22.))
                        .child(
                            div()
                                .flex()
                                .min_w_0()
                                .flex_1()
                                .gap(px(8.))
                                .overflow_hidden()
                                .text_size(px(13.))
                                .child(
                                    div()
                                        .flex_shrink_0()
                                        .whitespace_nowrap()
                                        .text_color(c(if current { INK } else { BODY }))
                                        .when(t.unread > 0, |d| d.font_weight(FontWeight::SEMIBOLD))
                                        .child(if t.counterpart.is_some() { id.name.clone() } else { format!("To {}", id.name) }),
                                )
                                .child(div().min_w_0().truncate().text_color(c(QUIET)).child(subject)),
                        )
                        .child(div().flex_shrink_0().whitespace_nowrap().text_size(px(11.5)).text_color(c(LABEL)).child(short_date(t.latest_date_ms))),
                ));
            }
        }
        if active && results.is_empty() && !loading {
            list = list.child(
                div().px(px(18.)).py(px(24.)).text_center().text_size(px(13.)).text_color(c(LABEL)).child(format!("No matches for “{settled}”")),
            );
        }
        if let Some((_, name)) = compose {
            list = list
                .child(cap("Actions").when(!results.is_empty(), |d| d.border_t_1().border_color(c(LINE)).pt(px(6.))))
                .child(
                    div().px(px(10.)).pb(px(8.)).child(
                        div()
                            .id("search-compose")
                            .flex()
                            .items_center()
                            .gap(px(10.))
                            .rounded(px(7.))
                            .px(px(10.))
                            .py(px(7.))
                            .cursor_pointer()
                            .text_size(px(13.))
                            .text_color(c(BRIGHT))
                            .hover(|s| s.bg(c(HOVER_STRONG)).text_color(c(INK)))
                            .on_click(cx.listener(|this, _, window, cx| this.search_compose(window, cx)))
                            .child(format!("Compose to {name}"))
                            .child(spacer())
                            .child(div().text_size(px(11.)).text_color(c(HINT)).child("⌘N")),
                    ),
                );
        }

        let panel = div()
            .key_context("Search")
            .relative()
            .w(px(560.))
            .max_w(relative(0.92))
            .max_h(relative(0.7))
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(px(14.))
            .border_1()
            .border_color(c(EDGE))
            .bg(c(PANEL))
            .shadow(vec![BoxShadow { color: hsla(0., 0., 0., 0.55), offset: point(px(0.), px(24.)), blur_radius: px(70.), spread_radius: px(0.), inset: false, }])
            .occlude()
            .child(
                div()
                    .flex()
                    .flex_shrink_0()
                    .items_center()
                    .gap(px(10.))
                    .border_b_1()
                    .border_color(c(LINE))
                    .px(px(18.))
                    .py(px(4.))
                    .child(svg().path("icons/search.svg").size(px(15.)).flex_shrink_0().text_color(c(LABEL)))
                    .child(div().h(px(44.)).flex_1().flex().items_center().text_size(px(14.)).text_color(c(INK)).child(gpui_kit::base::Input::new(&input)))
                    .child(div().flex_shrink_0().text_size(px(11.)).text_color(c(HINT)).child("esc")),
            )
            .child(list)
            .child(
                div()
                    .flex()
                    .flex_shrink_0()
                    .gap(px(16.))
                    .border_t_1()
                    .border_color(c(LINE))
                    .px(px(18.))
                    .py(px(9.))
                    .text_size(px(11.))
                    .text_color(c(HINT))
                    .child("↑↓ navigate")
                    .child("⏎ open"),
            );

        Some(
            div()
                .absolute()
                .inset_0()
                .flex()
                .justify_center()
                .items_start()
                .pt(px(64.))
                .child(
                    div()
                        .id("search-backdrop")
                        .absolute()
                        .inset_0()
                        .bg(hsla(0., 0., 0., 0.35))
                        .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| this.close_search(window, cx))),
                )
                .child(panel)
                .into_any_element(),
        )
    }
}
