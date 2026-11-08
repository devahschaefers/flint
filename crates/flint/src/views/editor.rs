//! The compose editor shared by the reply composer and New Message: a text
//! area holding Markdown, the glyph toolbar above it, and the `/` insert
//! menu. Port of Toolbar.tsx / RichEditor.tsx onto a plain text area: the
//! toolbar writes the Markdown the TipTap editor accepted as input rules
//! (`# `, `- `, `1. `, `> `, fences, `**bold**`), and sending converts it
//! to the text/html part (see util::mailhtml).

use crate::theme::*;
use gpui_kit::base::input::TextareaState;
use gpui_kit::*;
use crate::zoom::px;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditOp {
    Paragraph,
    Heading,
    Subheading,
    Bold,
    Italic,
    Underline,
    Bullets,
    Numbers,
    Quote,
    Code,
    Link,
    Image,
}

const LINE_PREFIXES: [&str; 5] = ["### ", "## ", "# ", "- ", "> "];

/// The line without any block marker ("## ", "- ", "3. ", "> ")
fn strip_block_prefix(line: &str) -> &str {
    for p in LINE_PREFIXES {
        if let Some(rest) = line.strip_prefix(p) {
            return rest;
        }
    }
    let digits = line.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits > 0 {
        if let Some(rest) = line[digits..].strip_prefix(". ") {
            return rest;
        }
    }
    line
}

fn current_line(text: &str, cursor: usize) -> (usize, usize) {
    let cursor = cursor.min(text.len());
    let start = text[..cursor].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let end = text[cursor..].find('\n').map(|i| cursor + i).unwrap_or(text.len());
    (start, end)
}

/// Is the caret's line exactly "/" (the insert menu's trigger)?
pub fn slash_active(state: &TextareaState) -> bool {
    let text = state.value();
    let (s, e) = current_line(&text, state.cursor());
    &text[s..e] == "/"
}

fn set_line_prefix(state: &mut TextareaState, prefix: &str, window: &mut Window, cx: &mut Context<TextareaState>) {
    let text = state.value().to_string();
    let (start, end) = current_line(&text, state.cursor());
    let line = &text[start..end];
    let stripped = strip_block_prefix(line);
    let replacement = if !prefix.is_empty() && line.starts_with(prefix) && stripped.len() + prefix.len() == line.len() {
        stripped.to_string()
    } else {
        format!("{prefix}{stripped}")
    };
    state.set_selected_range(start..end, cx);
    state.replace(replacement, window, cx);
}

fn wrap_selection(state: &mut TextareaState, before: &str, after: &str, window: &mut Window, cx: &mut Context<TextareaState>) {
    let range = state.selected_range();
    let text = state.value().to_string();
    let selected = text.get(range.clone()).unwrap_or("").to_string();
    state.replace(format!("{before}{selected}{after}"), window, cx);
    if selected.is_empty() {
        let at = range.start + before.len();
        state.set_selected_range(at..at, cx);
    }
}

pub fn apply(state: &Entity<TextareaState>, op: EditOp, window: &mut Window, cx: &mut App) {
    state.update(cx, |s, cx| {
        match op {
            EditOp::Paragraph => set_line_prefix(s, "", window, cx),
            EditOp::Heading => set_line_prefix(s, "# ", window, cx),
            EditOp::Subheading => set_line_prefix(s, "## ", window, cx),
            EditOp::Bullets => set_line_prefix(s, "- ", window, cx),
            EditOp::Numbers => set_line_prefix(s, "1. ", window, cx),
            EditOp::Quote => set_line_prefix(s, "> ", window, cx),
            EditOp::Bold => wrap_selection(s, "**", "**", window, cx),
            EditOp::Italic => wrap_selection(s, "*", "*", window, cx),
            EditOp::Underline => wrap_selection(s, "<u>", "</u>", window, cx),
            EditOp::Code => wrap_selection(s, "\n```\n", "\n```\n", window, cx),
            EditOp::Link => {
                let range = s.selected_range();
                let text = s.value().to_string();
                let selected = text.get(range).unwrap_or("").to_string();
                let label = if selected.is_empty() { "link".to_string() } else { selected };
                s.replace(format!("[{label}](https://)"), window, cx);
            }
            EditOp::Image => s.insert("\n[image]\n", window, cx),
        }
        s.focus(window, cx);
    });
}

/// Replace the "/" line with the chosen block
pub fn apply_slash(state: &Entity<TextareaState>, op: EditOp, window: &mut Window, cx: &mut App) {
    state.update(cx, |s, cx| {
        let text = s.value().to_string();
        let (start, end) = current_line(&text, s.cursor());
        s.set_selected_range(start..end, cx);
        let replacement = match op {
            EditOp::Heading => "# ",
            EditOp::Bullets => "- ",
            EditOp::Quote => "> ",
            EditOp::Code => "```\n\n```",
            EditOp::Image => "[image]\n",
            _ => "",
        };
        s.replace(replacement, window, cx);
        if op == EditOp::Code {
            let at = start + 4;
            s.set_selected_range(at..at, cx);
        }
        s.focus(window, cx);
    });
}

fn chip(id: impl Into<ElementId>, label: impl IntoElement, state: Entity<TextareaState>, op: EditOp) -> Stateful<Div> {
    div()
        .id(id)
        .flex()
        .items_center()
        .justify_center()
        .h(px(24.))
        .min_w(px(26.))
        .px(px(7.))
        .rounded(px(5.))
        .cursor_pointer()
        .hover(|s| s.bg(ca(INK, 0.1)).text_color(c(INK)))
        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
            window.prevent_default();
            apply(&state, op, window, cx);
        })
        .child(label)
}

fn divider() -> Div {
    div().mx(px(4.)).h(px(14.)).w(px(1.)).bg(c(EDGE))
}

/// Persistent formatting toolbar: glyphs, not icons
pub fn toolbar(prefix: &'static str, state: &Entity<TextareaState>) -> Div {
    let bold = |s: &'static str| div().font_weight(FontWeight::BOLD).child(s);
    let s = || state.clone();
    div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(2.))
        .text_size(px(11.))
        .text_color(c(QUIET))
        .child(chip((prefix, 0usize), "¶", s(), EditOp::Paragraph))
        .child(chip((prefix, 1usize), bold("H1"), s(), EditOp::Heading))
        .child(chip((prefix, 2usize), bold("H2"), s(), EditOp::Subheading))
        .child(divider())
        .child(chip((prefix, 3usize), bold("B"), s(), EditOp::Bold))
        .child(chip((prefix, 4usize), div().italic().font_family("Georgia").child("I"), s(), EditOp::Italic))
        .child(chip((prefix, 5usize), div().underline().child("U"), s(), EditOp::Underline))
        .child(divider())
        .child(chip((prefix, 6usize), "≡", s(), EditOp::Bullets))
        .child(chip((prefix, 7usize), "1.", s(), EditOp::Numbers))
        .child(divider())
        .child(chip((prefix, 8usize), "❝", s(), EditOp::Quote))
        .child(chip((prefix, 9usize), "</>", s(), EditOp::Code))
        .child(divider())
        .child(chip((prefix, 10usize), div().underline().child("a"), s(), EditOp::Link))
        .child(chip((prefix, 11usize), "▣", s(), EditOp::Image))
}

/// The `/` menu: shown while the caret's line is exactly "/"
pub fn slash_menu(prefix: &'static str, state: &Entity<TextareaState>) -> Div {
    let items: [(&str, &str, EditOp); 5] = [
        ("Heading", "H1", EditOp::Heading),
        ("Bulleted list", "≡", EditOp::Bullets),
        ("Quote", "❝", EditOp::Quote),
        ("Code block", "</>", EditOp::Code),
        ("Image", "▣", EditOp::Image),
    ];
    let mut panel = crate::views::widgets::popover_panel(200.).child(
        div().px(px(16.)).pb(px(6.)).text_size(px(10.)).text_color(c(HINT)).child("INSERT"),
    );
    for (i, (label, glyph, op)) in items.into_iter().enumerate() {
        let state = state.clone();
        panel = panel.child(
            div()
                .id((prefix, 100 + i))
                .flex()
                .items_center()
                .gap(px(10.))
                .px(px(16.))
                .py(px(6.))
                .cursor_pointer()
                .text_size(px(13.))
                .text_color(c(MUTED))
                .hover(|s| s.bg(c(HOVER_STRONG)).text_color(c(INK)))
                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    window.prevent_default();
                    apply_slash(&state, op, window, cx);
                })
                .child(div().w(px(24.)).flex_shrink_0().text_size(px(11.)).text_color(c(QUIET)).child(glyph))
                .child(label),
        );
    }
    panel
}

/// The text area itself, styled like the `.rt-editor` surface
pub fn editor_surface(state: &Entity<TextareaState>) -> Div {
    div()
        .px(px(16.))
        .pt(px(8.))
        .pb(px(14.))
        .text_size(px(13.5))
        .line_height(px(23.))
        .text_color(c(BODY))
        .child(gpui_kit::base::Textarea::new(state))
}

pub fn word_count(text: &str) -> usize {
    text.split_whitespace().count()
}

pub fn hint(word_count: Option<usize>) -> String {
    let words = match word_count {
        Some(n) if n > 0 => format!("{n} {} · ", if n == 1 { "word" } else { "words" }),
        _ => String::new(),
    };
    format!("{words}# heading · / commands · ⌘↵ send")
}

#[cfg(test)]
mod tests {
    use super::{current_line, strip_block_prefix};

    #[test]
    fn prefixes() {
        assert_eq!(strip_block_prefix("## Title"), "Title");
        assert_eq!(strip_block_prefix("12. item"), "item");
        assert_eq!(strip_block_prefix("plain"), "plain");
        assert_eq!(current_line("a\nbc\nd", 3), (2, 4));
        assert_eq!(current_line("abc", 3), (0, 3));
    }
}
