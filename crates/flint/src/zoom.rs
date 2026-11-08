//! Interface zoom (⌘ + / − / 0; Super on Linux, Ctrl on Windows). GPUI has
//! no page-level zoom, so every size in
//! the views goes through this `px`, which shadows GPUI's own `px` by being
//! imported explicitly. Window chrome (traffic lights, minimum size) stays put.

use std::sync::atomic::{AtomicU32, Ordering};

/// Chromium's zoom steps, 50%–300%
pub const STEPS: [f32; 13] = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

static ZOOM: AtomicU32 = AtomicU32::new(0x3f80_0000); // 1.0f32

pub fn zoom() -> f32 {
    f32::from_bits(ZOOM.load(Ordering::Relaxed))
}

/// Snap to the nearest step and apply; returns what was applied
pub fn set_zoom(value: f32) -> f32 {
    let snapped = STEPS
        .iter()
        .copied()
        .min_by(|a, b| (a - value).abs().total_cmp(&(b - value).abs()))
        .unwrap_or(1.0);
    ZOOM.store(snapped.to_bits(), Ordering::Relaxed);
    snapped
}

/// One step in or out from the current zoom
pub fn step(direction: i32) -> f32 {
    let current = zoom();
    let ix = STEPS.iter().position(|s| (s - current).abs() < 0.001).unwrap_or(5) as i32;
    let next = (ix + direction).clamp(0, STEPS.len() as i32 - 1) as usize;
    set_zoom(STEPS[next])
}

/// Logical pixels at the current zoom
#[inline]
pub fn px(value: f32) -> gpui_kit::Pixels {
    gpui_kit::px(value * zoom())
}

#[cfg(test)]
mod tests {
    #[test]
    fn steps_and_snapping() {
        assert_eq!(super::set_zoom(1.0), 1.0);
        assert_eq!(super::step(1), 1.1);
        assert_eq!(super::step(-1), 1.0);
        assert_eq!(super::set_zoom(9.0), 3.0);
        assert_eq!(super::step(1), 3.0);
        assert_eq!(super::set_zoom(1.02), 1.0);
    }
}
