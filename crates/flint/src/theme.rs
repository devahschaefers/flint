//! Design tokens, lifted from `src/renderer/src/styles/tokens.css` (the flat
//! "dead simple" language: one ink ground, whitespace instead of rules, one
//! blue accent, avatars as the only ornament).

#![allow(dead_code)]

use gpui_kit::{rgb, rgba, Rgba};

pub const FONT: &str = "Helvetica Neue";
pub const MONO: &str = "Menlo";

// Grounds, darkest to lightest
pub const BG: u32 = 0x151515;
pub const PILL: u32 = 0x1a1a1a;
pub const ROW: u32 = 0x1b1b1b;
pub const PANEL: u32 = 0x1c1c1c;
pub const POPOVER: u32 = 0x1d1d1d;
pub const PILL_HOVER: u32 = 0x1e1e1e;
pub const HOVER: u32 = 0x222222;
pub const HOVER_STRONG: u32 = 0x242424;
pub const LINE: u32 = 0x262626;
pub const LINE_STRONG: u32 = 0x2a2a2a;
pub const EDGE: u32 = 0x2e2e2e;
pub const BUTTON_HOVER: u32 = 0x2f2f2f;
pub const OFF: u32 = 0x333333;
pub const STACK: u32 = 0x3a3a3a;
pub const RULE_HOVER: u32 = 0x444444;

// Text ramp, brightest to faintest
pub const INK: u32 = 0xffffff;
pub const STRONG: u32 = 0xdddddd;
pub const BODY: u32 = 0xcccccc;
pub const BRIGHT: u32 = 0xbbbbbb;
pub const MUTED: u32 = 0xaaaaaa;
pub const DIM: u32 = 0x999999;
pub const QUIET: u32 = 0x888888;
pub const META: u32 = 0x777777;
pub const LABEL: u32 = 0x666666;
pub const HINT: u32 = 0x555555;

// The one accent
pub const ACCENT: u32 = 0x6f9df0;
pub const ACCENT_HOVER: u32 = 0x8db1f4;
pub const ACCENT_LIGHT: u32 = 0x9cbcf5;
pub const ON_ACCENT: u32 = 0x10131a;

// Status
pub const DANGER: u32 = 0xe06c6c;
pub const WARN: u32 = 0xe8b04c;

pub fn c(hex: u32) -> Rgba {
    rgb(hex)
}

/// `hex` at `alpha` (0..=1)
pub fn ca(hex: u32, alpha: f32) -> Rgba {
    rgba((hex << 8) | ((alpha.clamp(0.0, 1.0) * 255.0).round() as u32))
}
