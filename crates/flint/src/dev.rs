//! Debug-build hook for screenshots: `FLINT_OPEN=<screen>` opens a screen once
//! the first data arrives. Screens: `thread:<n>` (nth inbox row), `compose`,
//! `draft`, `search:<query>`, `settings`, `menu`, `filter`, `folder:<name>`,
//! `group:<category>`, `reply`, `reply-full`, `context`.

use crate::app::*;
use crate::views::thread::ReplyMode;
use gpui_kit::*;

impl FlintApp {
    pub fn dev_open_pending(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(cmd) = self.dev_open.clone() else { return };
        if !self.connected() {
            return;
        }
        let ready = if cmd.starts_with("mode:") {
            matches!(&self.page, PageState::Thread(t) if t.loaded)
        } else {
            matches!(&self.page, PageState::List(l) if l.loaded_once)
        };
        if !ready {
            return;
        }
        self.dev_open = None;
        cx.defer_in(window, move |this, window, cx| this.dev_apply(&cmd, window, cx));
    }

    fn dev_apply(&mut self, cmd: &str, window: &mut Window, cx: &mut Context<Self>) {
        let (name, arg) = cmd.split_once(':').unwrap_or((cmd, ""));
        let first_thread = |this: &FlintApp, n: usize| match &this.page {
            PageState::List(l) => l.threads.get(n).map(|t| t.thread_ref()),
            _ => None,
        };
        match name {
            "thread" | "reply" | "reply-full" => {
                if let Some(r) = first_thread(self, arg.parse().unwrap_or(0)) {
                    self.open_thread(r, window, cx);
                    if name != "thread" {
                        let mode = if name == "reply" { ReplyMode::Open } else { ReplyMode::Full };
                        self.dev_open = Some(format!("mode:{}", mode as u8));
                    }
                }
            }
            "mode" => {
                let mode = if arg == "1" { ReplyMode::Open } else { ReplyMode::Full };
                self.dev_set_reply_mode(mode, window, cx);
            }
            "compose" => self.open_compose(None, None, window, cx),
            "draft" => self.open_folder(FolderView::Drafts, window, cx),
            "search" => {
                self.open_search(window, cx);
                if let Some(s) = &self.search {
                    let input = s.input.clone();
                    let q = arg.to_string();
                    input.update(cx, |s, cx| s.set_value(q, window, cx));
                }
                self.run_search(arg.to_string(), cx);
            }
            "settings" => self.open_settings(window, cx),
            "menu" => self.set_popover(Some(Popover::Menu), cx),
            "filter" => self.set_popover(Some(Popover::Filter), cx),
            "folder" => {
                let f = FolderView::MENU.into_iter().find(|f| f.title().eq_ignore_ascii_case(arg)).unwrap_or(FolderView::Pins);
                self.open_folder(f, window, cx);
            }
            "group" => self.open_group(arg.to_string(), window, cx),
            "context" => {
                if let Some(r) = first_thread(self, 0) {
                    let entries = vec![
                        MenuEntry::Item("Done".into(), std::rc::Rc::new(move |this, _, cx| this.done(r.clone(), cx))),
                        MenuEntry::Item("Pin".into(), std::rc::Rc::new(|_, _, _| {})),
                        MenuEntry::Item("Mark as read".into(), std::rc::Rc::new(|_, _, _| {})),
                        MenuEntry::Separator,
                        MenuEntry::Item("Move to Trash".into(), std::rc::Rc::new(|_, _, _| {})),
                        MenuEntry::Item("Move to Spam".into(), std::rc::Rc::new(|_, _, _| {})),
                    ];
                    self.show_context_menu(point(px(700.), px(330.)), entries, cx);
                }
            }
            _ => log::warn!("FLINT_OPEN: unknown screen {cmd}"),
        }
        cx.notify();
    }
}
