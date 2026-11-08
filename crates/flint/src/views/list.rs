//! Thread lists: the smart inbox (bundles + important conversations), one
//! bundle opened as a list, and the folder lists (Pins, Drafts, Sent, Trash,
//! Spam, Archive). Port of InboxView, GroupListView, FolderListView,
//! ListHeader, BundleRow, ThreadRow, DraftRow, SendStatus.

use crate::app::*;
use crate::theme::*;
use crate::util::dates::{group_by_bucket, short_date};
use crate::util::identity::normalize_subject;
use crate::views::root::parse_hex;
use crate::views::widgets::*;
use flint_core::*;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use crate::zoom::px;
use std::rc::Rc;

impl FlintApp {
    /// Rows swap their date for their verbs while hovered. Tracked here rather
    /// than with group_hover styles, since GPUI cannot change an element's
    /// display between layout and paint.
    fn set_row_hover(&mut self, key: (&'static str, usize), hovered: bool, cx: &mut Context<Self>) {
        if hovered {
            self.hovered_row = Some(key);
        } else if self.hovered_row == Some(key) {
            self.hovered_row = None;
        }
        cx.notify();
    }

    /// Tallest a popover can be and still fit inside its 12px window margin
    pub fn popover_max_height(&self) -> Pixels {
        (self.viewport.height - px(24.)).max(px(1.))
    }

    /// 9% of the window, widening only when interface zoom would otherwise put
    /// the page under the icon strip (18 left + 28 wide + 18 clear)
    fn page_gutter(&self) -> Pixels {
        (self.viewport.width * 0.09).max(px(64.))
    }

    /// The one layout: a scrolling column with generous side margins and no chrome
    pub fn page(&self, id: &'static str, tight: bool, content: impl IntoElement) -> AnyElement {
        div()
            .id(id)
            .size_full()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .child(
                div()
                    .px(self.page_gutter())
                    .pt(px(if tight { 26. } else { 32. }))
                    .pb(px(if tight { 48. } else { 60. }))
                    .child(content),
            )
            .into_any_element()
    }

    pub fn render_list(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if !self.connected() {
            let empty = self.render_no_account(cx);
            return self.page("page-empty", false, empty);
        }

        // Infinite scroll: fetch the next page when the bottom is within 400px
        let near_bottom = {
            let offset = -self.scroll.offset().y;
            let max = self.scroll.max_offset().y;
            max - offset < px(400.)
        };
        if near_bottom {
            if let PageState::List(list) = &self.page {
                if list.has_more && !list.loading {
                    self.load_more(cx);
                }
            }
        }

        let content = match self.view.clone() {
            Screen::Inbox => self.render_inbox(cx),
            Screen::Group(category) => self.render_group(&category, cx),
            Screen::Folder(FolderView::Drafts) => self.render_drafts(cx),
            Screen::Folder(folder) => self.render_folder(folder, cx),
            _ => div().into_any_element(),
        };
        self.page("page-list", false, content)
    }

    fn render_no_account(&mut self, cx: &mut Context<Self>) -> AnyElement {
        div()
            .child(self.list_header("Inbox", None, cx))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(8.))
                    .pt(px(180.))
                    .child(div().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).text_color(c(INK)).child("No account connected"))
                    .child(
                        div()
                            .max_w(px(320.))
                            .text_center()
                            .text_size(px(13.))
                            .line_height(px(21.))
                            .text_color(c(LABEL))
                            .child("Connect your Gmail to start syncing mail into Flint."),
                    )
                    .child(div().mt(px(12.)).child(primary_button(
                        "add-account",
                        "Add account",
                        true,
                        Box::new(cx.listener(|this, _, window, cx| this.open_settings(window, cx))),
                    ))),
            )
            .into_any_element()
    }

    fn list(&self) -> Option<&ListPage> {
        match &self.page {
            PageState::List(l) => Some(l),
            _ => None,
        }
    }

    fn render_inbox(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let unread: i64 = self
            .unread
            .iter()
            .filter(|u| self.active_account.as_ref().is_none_or(|a| a == &u.account_id))
            .map(|u| u.inbox_unread)
            .sum();
        let Some(list) = self.list() else { return div().into_any_element() };
        let groups = list.overview.as_ref().map(|o| o.groups.clone()).unwrap_or_default();
        let threads = list.threads.clone();
        let empty = groups.is_empty() && threads.is_empty() && list.loaded_once && !list.loading;

        let mut col = div().child(self.list_header("Inbox", Some(format!("{unread} unread")), cx));
        if !groups.is_empty() {
            col = col.child(
                div()
                    .mt(px(14.))
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .children(groups.iter().enumerate().map(|(i, g)| self.bundle_row(i, g, cx))),
            );
        }
        col = col.children(self.thread_sections(&threads, cx));
        if empty {
            col = col.child(empty_notice("Inbox zero — nothing left"));
        }
        col.into_any_element()
    }

    fn render_group(&mut self, category: &str, cx: &mut Context<Self>) -> AnyElement {
        let title = category_label(category);
        let Some(list) = self.list() else { return div().into_any_element() };
        let threads = list.threads.clone();
        let empty = threads.is_empty() && list.loaded_once && !list.loading;
        let cat = category.to_string();
        div()
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .gap(px(10.))
                    .child(self.back_link(cx))
                    .child(div().ml(px(4.)).text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).text_color(c(INK)).child(title.clone()))
                    .child(spacer())
                    .when(!threads.is_empty(), |d| {
                        d.child(text_action(
                            "mark-all-done",
                            "Mark all done",
                            false,
                            Box::new(cx.listener(move |this, _, window, cx| {
                                this.archive_group(cat.clone(), cx);
                                this.go_inbox(window, cx);
                            })),
                        ))
                    }),
            )
            .children(self.thread_sections(&threads, cx))
            .when(empty, |d| d.child(empty_notice(format!("Nothing in {title}"))))
            .into_any_element()
    }

    fn render_folder(&mut self, folder: FolderView, cx: &mut Context<Self>) -> AnyElement {
        let title = folder.title();
        let Some(list) = self.list() else { return div().into_any_element() };
        let threads = list.threads.clone();
        let empty = threads.is_empty() && list.loaded_once && !list.loading;
        div()
            .child(self.list_header(title, None, cx))
            .children(self.thread_sections(&threads, cx))
            .when(empty, |d| d.child(empty_notice(format!("Nothing in {title}"))))
            .into_any_element()
    }

    fn render_drafts(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let Some(list) = self.list() else { return div().into_any_element() };
        let drafts = list.drafts.clone();
        let empty = drafts.is_empty() && list.loaded_once && !list.loading;
        let count = drafts.len();
        let right = (count > 0).then(|| format!("{count} {}", if count == 1 { "draft" } else { "drafts" }));
        let mut col = div().child(self.list_header("Drafts", right, cx));
        let mut ix = 0;
        for (bucket, items) in group_by_bucket(&drafts, |m| m.date_ms) {
            let mut section = div().child(section_label(bucket.label()));
            for draft in items {
                section = section.child(self.draft_row(ix, draft, cx));
                ix += 1;
            }
            col = col.child(section);
        }
        if empty {
            col = col.child(empty_notice("Nothing in Drafts"));
        }
        col.into_any_element()
    }

    fn thread_sections(&mut self, threads: &[WireThread], cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mut out = Vec::new();
        let mut ix = 0;
        for (bucket, items) in group_by_bucket(threads, |t| t.latest_date_ms) {
            let mut section = div().child(section_label(bucket.label()));
            for thread in items {
                section = section.child(self.thread_row(ix, thread, cx));
                ix += 1;
            }
            out.push(section.into_any_element());
        }
        out
    }

    /// "← Inbox", or wherever the reader came from
    pub fn back_link(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let label = match &self.prev_view {
            Some(Screen::Group(c)) => category_label(c),
            Some(Screen::Folder(f)) => f.title().to_string(),
            _ => "Inbox".to_string(),
        };
        div()
            .id("back-link")
            .mx(px(-8.))
            .my(px(-4.))
            .px(px(8.))
            .py(px(4.))
            .rounded(px(6.))
            .whitespace_nowrap()
            .text_size(px(12.))
            .text_color(c(LABEL))
            .cursor_pointer()
            .hover(|s| s.bg(c(HOVER)).text_color(c(BODY)))
            .on_click(cx.listener(|this, _, window, cx| {
                if matches!(this.view, Screen::Group(_)) {
                    this.go_inbox(window, cx)
                } else {
                    this.back(window, cx)
                }
            }))
            .child(format!("← {label}"))
    }

    /// The header is the menu: the title opens a panel with every place the
    /// old sidebar held, then vanishes.
    fn list_header(&mut self, title: &str, right: Option<String>, cx: &mut Context<Self>) -> impl IntoElement {
        let menu_open = self.popover == Some(Popover::Menu);
        let active = self.active_account.clone().and_then(|id| self.account(&id).cloned());
        div()
            .flex()
            .items_baseline()
            .gap(px(8.))
            .child(
                div()
                    .relative()
                    .flex_none()
                    .child(
                        div()
                            .id("header-title")
                            .flex()
                            .items_baseline()
                            .gap(px(4.))
                            .whitespace_nowrap()
                            .border_b_1()
                            .border_color(if menu_open { c(RULE_HOVER).into() } else { transparent_black() })
                            .hover(|s| s.border_color(c(RULE_HOVER)))
                            .cursor_pointer()
                            .text_size(px(15.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(c(INK))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.set_popover((!menu_open).then_some(Popover::Menu), cx)
                            }))
                            .child(title.to_string())
                            .child(div().text_size(px(11.)).text_color(c(HINT)).child(if menu_open { "▴" } else { "▾" })),
                    )
                    .when(menu_open, |d| d.child(self.header_menu(cx))),
            )
            .when_some(active, |d, a| {
                d.child(
                    div()
                        .id("account-chip")
                        // The address gives way before the unread count does
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .min_w_0()
                        .rounded_full()
                        .px(px(9.))
                        .py(px(2.))
                        .bg(ca(ACCENT, 0.12))
                        .hover(|s| s.bg(ca(ACCENT, 0.2)))
                        .cursor_pointer()
                        .text_size(px(11.))
                        .text_color(c(ACCENT_LIGHT))
                        .on_click(cx.listener(|this, _, window, cx| this.set_account(None, window, cx)))
                        .child(div().min_w_0().truncate().child(a.email.clone()))
                        .child(div().flex_none().child("✕")),
                )
            })
            .child(spacer())
            .when_some(right, |d, r| {
                d.child(div().flex_none().whitespace_nowrap().text_size(px(12.)).text_color(c(META)).child(r))
            })
    }

    fn header_menu(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let view = self.view.clone();
        let mut panel = bounded_popover_panel(240., self.popover_max_height())
            .child(popover_label("Go to"))
            .child(
                popover_item("menu-inbox", view == Screen::Inbox, Box::new(cx.listener(|this, _, w, cx| this.go_inbox(w, cx))))
                    .child("Inbox"),
            );
        for f in FolderView::MENU {
            panel = panel.child(
                popover_item(("menu-folder", f as usize), view == Screen::Folder(f), Box::new(cx.listener(move |this, _, w, cx| this.open_folder(f, w, cx))))
                    .child(f.title())
                    .child(spacer())
                    .when_some(f.shortcut(), |d, k| d.child(div().text_size(px(11.)).text_color(c(HINT)).child(k))),
            );
        }
        panel = panel.child(
            popover_item("menu-settings", false, Box::new(cx.listener(|this, _, w, cx| this.open_settings(w, cx))))
                .child("Settings")
                .child(spacer())
                .child(div().text_size(px(11.)).text_color(c(HINT)).child("⌘,")),
        );
        if self.accounts.len() > 1 {
            panel = panel.child(popover_divider()).child(popover_label("Accounts"));
            for (i, a) in self.accounts.iter().enumerate() {
                let id = a.id.clone();
                let on = self.active_account.as_deref() == Some(a.id.as_str());
                panel = panel.child(
                    popover_item(("menu-acct", i), on, Box::new(cx.listener(move |this, _, w, cx| this.set_account(Some(id.clone()), w, cx))))
                        .child(dot(Some(parse_hex(&a.color))))
                        .child(div().truncate().child(a.email.clone()))
                        .child(spacer())
                        .when(on, |d| d.child(check())),
                );
            }
            let all = self.active_account.is_none();
            panel = panel.child(
                popover_item("menu-all", all, Box::new(cx.listener(|this, _, w, cx| this.set_account(None, w, cx))))
                    .child(dot(None))
                    .child("All accounts")
                    .child(spacer())
                    .when(all, |d| d.child(check())),
            );
        }
        if !self.accounts.is_empty() {
            panel = panel.child(popover_divider()).child(
                popover_item("menu-refresh", false, Box::new(cx.listener(|this, _, _, cx| {
                    this.refresh(cx);
                    this.set_popover(None, cx);
                })))
                .child("Refresh"),
            );
        }
        div()
            .absolute()
            .left(px(0.))
            .top(px(24.))
            .child(deferred(anchored().snap_to_window_with_margin(px(12.)).child(panel)).with_priority(1))
    }

    /// One smart-inbox bundle as a quiet line: who, what's new, an arrow
    fn bundle_row(&mut self, ix: usize, group: &InboxGroup, cx: &mut Context<Self>) -> AnyElement {
        const STACK_SHOWN: usize = 3;
        let label = category_label(&group.category);
        let shown: Vec<_> = group.chips.iter().take(STACK_SHOWN).collect();
        let more = group.chips.len().saturating_sub(shown.len());
        let contacts = self.contacts.clone();
        let (open_cat, done_cat) = (group.category.clone(), group.category.clone());

        let mut stack = div().flex().flex_shrink_0();
        for (i, chip) in shown.iter().enumerate() {
            let id = contacts.resolve(&chip.mailbox);
            stack = stack.child(
                avatar(id.initials, id.color, 18.)
                    .border(px(1.5))
                    .border_color(c(BG))
                    .when(i > 0, |d| d.ml(px(-5.))),
            );
        }
        if more > 0 {
            stack = stack.child(avatar(format!("+{more}"), STACK, 18.).border(px(1.5)).border_color(c(BG)).ml(px(-5.)));
        }

        let hovered = self.hovered_row == Some(("bundle", ix));
        div()
            .id(("bundle", ix))
            .on_hover(cx.listener(move |this, h: &bool, _, cx| this.set_row_hover(("bundle", ix), *h, cx)))
            .mx(px(-12.))
            .px(px(12.))
            .py(px(6.))
            .flex()
            .items_center()
            .gap(px(10.))
            .rounded(px(8.))
            .cursor_pointer()
            .text_size(px(13.))
            .text_color(c(DIM))
            .hover(|s| s.bg(c(ROW)).text_color(c(BODY)))
            .on_click(cx.listener(move |this, _, window, cx| this.open_group(open_cat.clone(), window, cx)))
            .child(stack)
            .child(div().whitespace_nowrap().child(label))
            .child(if group.unread > 0 {
                div().whitespace_nowrap().text_color(c(ACCENT)).child(format!("{} new", group.unread))
            } else {
                div().whitespace_nowrap().text_color(c(META)).child(group.count.to_string())
            })
            .child(spacer())
            .when(hovered, |d| {
                d.child(div().text_size(px(12.)).text_color(c(STRONG)).child(row_action(
                    ("bundle-done", ix),
                    "Mark all done",
                    false,
                    Box::new(cx.listener(move |this, _, _, cx| this.archive_group(done_cat.clone(), cx))),
                )))
            })
            .child(div().text_color(c(HINT)).child("→"))
            .into_any_element()
    }

    /// One conversation: avatar, sender, subject, date; hover swaps the date
    /// for Done · Pin · Open; right-click has the rest
    fn thread_row(&mut self, ix: usize, t: &WireThread, cx: &mut Context<Self>) -> AnyElement {
        let contacts = self.contacts.clone();
        let r = t.thread_ref();
        // Avatar identity is address-keyed: the counterpart, else the first recipient
        let avatar_mailbox = t.counterpart.clone().or_else(|| t.latest.to.first().cloned()).unwrap_or_else(|| t.latest.from.clone());
        let identity = contacts.resolve(&avatar_mailbox);
        let name = if t.counterpart.is_some() {
            identity.name.clone()
        } else if !t.latest.to.is_empty() {
            format!("To {}", contacts.names(&t.latest.to))
        } else {
            "To (no recipient)".into()
        };
        let unread = t.unread > 0;
        let f = t.folders;
        let archived = f.inbox == 0 && f.archive > 0;
        let trash_or_spam = f.trash > 0 || f.spam > 0;
        let movable = t.count > f.sent + f.drafts;
        let subject = Some(normalize_subject(&t.subject)).filter(|s| !s.is_empty()).unwrap_or_else(|| "(no subject)".into());
        let flagged = t.flagged;

        let primary: Option<(&'static str, ThreadAction, bool)> = if trash_or_spam {
            Some(("Restore", ThreadAction::Inbox, false))
        } else if archived {
            Some(("To inbox", ThreadAction::ToggleArchive, false))
        } else if f.inbox > 0 {
            Some(("Done", ThreadAction::Archive, true))
        } else {
            None
        };

        let open_ref = r.clone();
        let hovered = self.hovered_row == Some(("thread", ix));
        let mut actions = div()
            .flex()
            .flex_shrink_0()
            .items_center()
            .gap(px(2.))
            .text_size(px(12.5))
            .text_color(c(STRONG));
        if let Some((label, action, is_done)) = primary {
            let r2 = r.clone();
            actions = actions.child(row_action(
                ("row-primary", ix),
                label,
                false,
                Box::new(cx.listener(move |this, _, _, cx| {
                    if is_done {
                        this.done(r2.clone(), cx)
                    } else {
                        this.thread_action(vec![r2.clone()], action, cx)
                    }
                })),
            ));
        }
        let r_pin = r.clone();
        actions = actions
            .child(row_action(
                ("row-pin", ix),
                if flagged { "Unpin" } else { "Pin" },
                false,
                Box::new(cx.listener(move |this, _, _, cx| this.thread_action(vec![r_pin.clone()], ThreadAction::ToggleFlagged, cx))),
            ))
            .child(row_action(
                ("row-open", ix),
                "Open",
                true,
                Box::new(cx.listener({
                    let r = r.clone();
                    move |this, _, window, cx| this.open_thread(r.clone(), window, cx)
                })),
            ));

        let meta = div()
            .flex()
            .flex_shrink_0()
            .items_center()
            .gap(px(8.))
            .when(flagged, |d| d.child(div().text_size(px(9.)).text_color(c(META)).child("◆")))
            .when(unread, |d| d.child(div().size(px(6.)).rounded_full().bg(c(ACCENT))))
            .child(div().whitespace_nowrap().text_size(px(12.)).text_color(c(META)).child(short_date(t.latest_date_ms)));

        let menu_ref = r.clone();
        div()
            .id(("thread", ix))
            .on_hover(cx.listener(move |this, h: &bool, _, cx| this.set_row_hover(("thread", ix), *h, cx)))
            .mx(px(-12.))
            .px(px(12.))
            .py(px(10.))
            .flex()
            .items_center()
            .gap(px(12.))
            .rounded(px(8.))
            .cursor_pointer()
            .hover(|s| s.bg(c(ROW)))
            .when(archived, |d| d.opacity(0.45))
            .on_click(cx.listener(move |this, _, window, cx| this.open_thread(open_ref.clone(), window, cx)))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, ev: &MouseDownEvent, _, cx| {
                    let entries = thread_menu(menu_ref.clone(), archived, trash_or_spam, movable, flagged, unread);
                    this.show_context_menu(ev.position, entries, cx);
                }),
            )
            .child(avatar(identity.initials.clone(), identity.color, 26.))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .items_center()
                    .gap(px(9.))
                    .child(
                        div()
                            .flex()
                            .flex_1()
                            .min_w_0()
                            .items_baseline()
                            .gap(px(9.))
                            .overflow_hidden()
                            .child(
                                div()
                                    .flex()
                                    .items_baseline()
                                    .flex_shrink_0()
                                    .whitespace_nowrap()
                                    .text_size(px(13.5))
                                    .when(unread, |d| d.font_weight(FontWeight::SEMIBOLD).text_color(c(INK)))
                                    .when(!unread, |d| d.text_color(c(DIM)))
                                    .child(name)
                                    .when(t.count > 1, |d| {
                                        d.child(
                                            div()
                                                .ml(px(6.))
                                                .text_size(px(12.))
                                                .font_weight(FontWeight::NORMAL)
                                                .text_color(c(META))
                                                .child(t.count.to_string()),
                                        )
                                    }),
                            )
                            .child(
                                div()
                                    .min_w_0()
                                    .truncate()
                                    .text_size(px(13.5))
                                    .text_color(c(if unread { STRONG } else { QUIET }))
                                    .child(subject),
                            )
                            .when(t.latest.folder == Folder::Drafts, |d| {
                                d.child(div().flex_shrink_0().text_size(px(11.)).text_color(c(WARN)).child("Draft"))
                            })
                            .children(send_status(t.latest.state)),
                    )
                    .child(if hovered { actions } else { meta }),
            )
            .into_any_element()
    }

    fn draft_row(&mut self, ix: usize, draft: &WireMessage, cx: &mut Context<Self>) -> AnyElement {
        let contacts = self.contacts.clone();
        let resolved = draft.to.first().map(|m| contacts.resolve(m));
        let name = if draft.to.is_empty() { "(no recipient)".to_string() } else { contacts.names(&draft.to) };
        let subject = if draft.subject.is_empty() || draft.subject == "(no subject)" { "Untitled".to_string() } else { draft.subject.clone() };
        let (d_open, d_open2, d_menu) = (draft.clone(), draft.clone(), draft.clone());
        let (acct, hdr) = (draft.account_id.clone(), draft.message_id_hdr.clone().unwrap_or_default());
        let hovered = self.hovered_row == Some(("draft", ix));

        div()
            .id(("draft", ix))
            .on_hover(cx.listener(move |this, h: &bool, _, cx| this.set_row_hover(("draft", ix), *h, cx)))
            .mx(px(-12.))
            .px(px(12.))
            .py(px(10.))
            .flex()
            .items_center()
            .gap(px(12.))
            .rounded(px(8.))
            .cursor_pointer()
            .hover(|s| s.bg(c(ROW)))
            .on_click(cx.listener(move |this, _, window, cx| this.open_compose(Some(d_open.clone()), None, window, cx)))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, ev: &MouseDownEvent, _, cx| {
                    let (edit, del) = (d_menu.clone(), d_menu.clone());
                    let entries = vec![
                        MenuEntry::Item("Edit draft".into(), Rc::new(move |this, w, cx| this.open_compose(Some(edit.clone()), None, w, cx))),
                        MenuEntry::Item(
                            "Delete draft".into(),
                            Rc::new(move |this, _, cx| {
                                this.delete_draft(del.account_id.clone(), del.message_id_hdr.clone().unwrap_or_default(), cx)
                            }),
                        ),
                    ];
                    this.show_context_menu(ev.position, entries, cx);
                }),
            )
            .child(match &resolved {
                Some(id) => avatar(id.initials.clone(), id.color, 26.),
                None => avatar("?", STACK, 26.),
            })
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .items_center()
                    .gap(px(9.))
                    .child(
                        div()
                            .flex()
                            .flex_1()
                            .min_w_0()
                            .items_baseline()
                            .gap(px(9.))
                            .overflow_hidden()
                            .child(div().flex_shrink_0().whitespace_nowrap().text_size(px(13.5)).text_color(c(DIM)).child(name))
                            .child(div().min_w_0().truncate().text_size(px(13.5)).text_color(c(QUIET)).child(subject)),
                    )
                    .child(if hovered {
                        div()
                            .flex()
                            .flex_shrink_0()
                            .items_center()
                            .gap(px(2.))
                            .text_size(px(12.5))
                            .text_color(c(STRONG))
                            .child(row_action(("draft-del", ix), "Delete", false, Box::new(cx.listener(move |this, _, _, cx| this.delete_draft(acct.clone(), hdr.clone(), cx)))))
                            .child(row_action(("draft-open", ix), "Open", true, Box::new(cx.listener(move |this, _, w, cx| this.open_compose(Some(d_open2.clone()), None, w, cx)))))
                    } else {
                        div()
                            .flex_shrink_0()
                            .whitespace_nowrap()
                            .text_size(px(12.))
                            .text_color(c(META))
                            .child(short_date(draft.date_ms))
                    }),
            )
            .into_any_element()
    }
}

fn thread_menu(r: ThreadRef, archived: bool, trash_or_spam: bool, movable: bool, flagged: bool, unread: bool) -> Vec<MenuEntry> {
    let act = |label: &str, action: ThreadAction, r: &ThreadRef| {
        let r = r.clone();
        MenuEntry::Item(label.to_string().into(), Rc::new(move |this: &mut FlintApp, _: &mut Window, cx: &mut Context<FlintApp>| this.thread_action(vec![r.clone()], action, cx)))
    };
    let mut entries = Vec::new();
    if !trash_or_spam {
        if archived {
            entries.push(act("Move to Inbox", ThreadAction::ToggleArchive, &r));
        } else {
            let r2 = r.clone();
            entries.push(MenuEntry::Item("Done".into(), Rc::new(move |this, _, cx| this.done(r2.clone(), cx))));
        }
    }
    entries.push(act(if flagged { "Unpin" } else { "Pin" }, ThreadAction::ToggleFlagged, &r));
    entries.push(act(if unread { "Mark as read" } else { "Mark as unread" }, ThreadAction::ToggleSeen, &r));
    if trash_or_spam || movable {
        entries.push(MenuEntry::Separator);
    }
    if trash_or_spam {
        entries.push(act("Move to Inbox", ThreadAction::Inbox, &r));
    } else if movable {
        entries.push(act("Move to Trash", ThreadAction::Trash, &r));
        entries.push(act("Move to Spam", ThreadAction::Spam, &r));
    }
    entries
}

pub fn empty_notice(text: impl Into<SharedString>) -> Div {
    div().py(px(60.)).text_center().text_size(px(13.)).text_color(c(LABEL)).child(text.into())
}

/// Compact lifecycle label for mail that hasn't reached Gmail (or failed to)
pub fn send_status(state: MessageState) -> Option<Div> {
    let (label, failed) = match state {
        MessageState::Failed => ("Failed to send", true),
        MessageState::Queued | MessageState::Sending => ("Sending…", false),
        _ => return None,
    };
    Some(
        div()
            .flex()
            .flex_shrink_0()
            .items_center()
            .gap(px(6.))
            .text_size(px(11.))
            .text_color(c(if failed { DANGER } else { META }))
            .when(!failed, |d| d.child(spinner()))
            .child(label),
    )
}
