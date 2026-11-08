//! Small building blocks shared by every screen: the initials avatar, the
//! popover panel and its rows, text actions, the toggle switch.

use crate::theme::*;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use crate::zoom::px;

pub type OnClick = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// Initials disc: the one ornament in the language, in a person's color
pub fn avatar(initials: impl Into<SharedString>, color: u32, size: f32) -> Div {
    let font = (size * 0.37 * 2.0).round() / 2.0;
    div()
        .flex()
        .flex_shrink_0()
        .items_center()
        .justify_center()
        .size(px(size))
        .rounded_full()
        .bg(c(color))
        .text_color(c(INK))
        .text_size(px(font))
        .font_weight(FontWeight::SEMIBOLD)
        .line_height(px(font))
        .child(initials.into())
}

/// Quiet section label ("Today", "Yesterday"); whitespace above separates
pub fn section_label(label: impl Into<SharedString>) -> Div {
    div().mt(px(28.)).mb(px(6.)).text_size(px(11.)).text_color(c(LABEL)).child(label.into())
}

/// Small text action ("Mark all done", "Done", "Pin")
pub fn text_action(id: impl Into<ElementId>, label: impl Into<SharedString>, accent_hover: bool, on_click: OnClick) -> Stateful<Div> {
    div()
        .id(id)
        .whitespace_nowrap()
        .rounded(px(6.))
        .px(px(8.))
        .py(px(4.))
        .text_size(px(12.))
        .text_color(c(LABEL))
        .cursor_pointer()
        .hover(move |s| s.bg(c(HOVER)).text_color(c(if accent_hover { ACCENT } else { BODY })))
        .on_click(on_click)
        .child(label.into())
}

/// A verb under the cursor; appears on row hover in place of the date
pub fn row_action(id: impl Into<ElementId>, label: impl Into<SharedString>, accent: bool, on_click: OnClick) -> Stateful<Div> {
    div()
        .id(id)
        .rounded(px(5.))
        .px(px(7.))
        .py(px(2.))
        .cursor_pointer()
        .when(accent, |d| d.text_color(c(ACCENT)))
        .hover(|s| s.bg(c(LINE_STRONG)).text_color(c(ACCENT)))
        .on_click(move |ev, window, cx| {
            cx.stop_propagation();
            on_click(ev, window, cx)
        })
        .child(label.into())
}

/// A popover panel that scrolls rather than running off a short window
pub fn bounded_popover_panel(width: f32, max_height: Pixels) -> Stateful<Div> {
    popover_panel(width)
        .id("popover-panel")
        .max_h(max_height)
        .overflow_y_scroll()
}

/// The floating panel used by the header menu, the filter, and context menus
pub fn popover_panel(width: f32) -> Div {
    div()
        .w(px(width))
        .py(px(8.))
        .rounded(px(10.))
        .border_1()
        .border_color(c(EDGE))
        .bg(c(POPOVER))
        .text_size(px(13.))
        .shadow(vec![BoxShadow {
            color: hsla(0., 0., 0., 0.5),
            offset: point(px(0.), px(16.)),
            blur_radius: px(48.),
            spread_radius: px(0.),
        inset: false,
        }])
        // Clicks inside the panel never reach the backdrop behind it
        .occlude()
}

pub fn popover_label(label: impl Into<SharedString>) -> Div {
    div()
        .px(px(16.))
        .pt(px(4.))
        .pb(px(8.))
        .text_size(px(10.))
        .text_color(c(HINT))
        .child(label.into().to_uppercase())
}

pub fn popover_item(id: impl Into<ElementId>, active: bool, on_click: OnClick) -> Stateful<Div> {
    div()
        .id(id)
        .flex()
        .items_center()
        .gap(px(9.))
        .px(px(16.))
        .py(px(6.))
        .cursor_pointer()
        .text_color(c(if active { INK } else { MUTED }))
        .hover(|s| s.bg(c(HOVER_STRONG)).text_color(c(INK)))
        .on_click(on_click)
}

pub fn popover_divider() -> Div {
    div().my(px(8.)).h(px(1.)).bg(c(LINE))
}

pub fn spacer() -> Div {
    div().flex_1()
}

/// Account color dot (or the hollow "all accounts" ring)
pub fn dot(color: Option<u32>) -> Div {
    let d = div().size(px(8.)).flex_shrink_0().rounded_full();
    match color {
        Some(col) => d.bg(c(col)),
        None => d.border_1().border_color(c(RULE_HOVER)),
    }
}

pub fn check() -> Div {
    div().text_color(c(ACCENT)).child("✓")
}

/// 32×18 switch: accent when on, dark when off
pub fn toggle(id: impl Into<ElementId>, on: bool, on_click: OnClick) -> Stateful<Div> {
    div()
        .id(id)
        .relative()
        .flex_shrink_0()
        .w(px(32.))
        .h(px(18.))
        .rounded_full()
        .cursor_pointer()
        .bg(c(if on { ACCENT } else { OFF }))
        .on_click(on_click)
        .child(
            div()
                .absolute()
                .top(px(2.))
                .left(px(if on { 16. } else { 2. }))
                .size(px(14.))
                .rounded_full()
                .bg(c(INK)),
        )
}

/// Primary accent button ("Send", "Add account")
pub fn primary_button(id: impl Into<ElementId>, label: impl Into<SharedString>, enabled: bool, on_click: OnClick) -> Stateful<Div> {
    div()
        .id(id)
        .rounded(px(8.))
        .px(px(18.))
        .py(px(7.))
        .bg(c(ACCENT))
        .text_size(px(13.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(c(ON_ACCENT))
        .when(!enabled, |d| d.opacity(0.4))
        .when(enabled, |d| d.cursor_pointer().hover(|s| s.bg(c(ACCENT_HOVER))).on_click(on_click))
        .child(label.into())
}

/// Quiet secondary button ("Save draft", "Cancel")
pub fn quiet_button(id: impl Into<ElementId>, label: impl Into<SharedString>, enabled: bool, on_click: OnClick) -> Stateful<Div> {
    div()
        .id(id)
        .rounded(px(6.))
        .px(px(8.))
        .py(px(4.))
        .text_size(px(12.5))
        .text_color(c(QUIET))
        .when(!enabled, |d| d.opacity(0.4))
        .when(enabled, |d| {
            d.cursor_pointer().hover(|s| s.bg(c(LINE_STRONG)).text_color(c(BODY))).on_click(on_click)
        })
        .child(label.into())
}

/// The pill shape used by the toast and the outbox banner
pub fn pill() -> Div {
    div()
        .flex()
        .items_center()
        .min_w_0()
        .gap(px(12.))
        .rounded(px(20.))
        .border_1()
        .border_color(c(EDGE))
        .bg(c(HOVER_STRONG))
        .py(px(8.))
        .pl(px(16.))
        .pr(px(12.))
        .text_size(px(12.5))
        .text_color(c(STRONG))
        .shadow(vec![BoxShadow {
            color: hsla(0., 0., 0., 0.5),
            offset: point(px(0.), px(6.)),
            blur_radius: px(20.),
            spread_radius: px(0.),
        inset: false,
        }])
}

pub fn pill_button(id: impl Into<ElementId>, label: impl Into<SharedString>, primary: bool, on_click: OnClick) -> Stateful<Div> {
    div()
        .id(id)
        .flex_none()
        .rounded(px(6.))
        .px(px(8.))
        .py(px(3.))
        .my(px(-3.))
        .cursor_pointer()
        .when(primary, |d| d.font_weight(FontWeight::SEMIBOLD).text_color(c(ACCENT)))
        .when(!primary, |d| d.text_color(c(QUIET)))
        .hover(|s| s.bg(c(BUTTON_HOVER)).text_color(c(INK)))
        .on_click(on_click)
        .child(label.into())
}

/// Small in-flight marker (the CSS spinner's stand-in)
pub fn spinner() -> Div {
    div()
        .size(px(11.))
        .flex_shrink_0()
        .rounded_full()
        .border(px(1.5))
        .border_color(c(META))
}
