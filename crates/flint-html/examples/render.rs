//! cargo run -p flint-html --example render -- <in.html> <out.png> [width] [scale]
use flint_html::{MailDocument, RenderOptions};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let html = std::fs::read_to_string(&args[1])?;
    let width: f32 = args.get(3).and_then(|v| v.parse().ok()).unwrap_or(700.0);
    let scale: f32 = args.get(4).and_then(|v| v.parse().ok()).unwrap_or(2.0);
    let t = std::time::Instant::now();
    let mut doc = MailDocument::new(&html, &RenderOptions { width, scale, stylesheet: String::new(), fetch: None })?;
    let laid = t.elapsed();
    let painted = doc.paint();
    eprintln!(
        "{}x{} css h={} blocked={} layout={:?} total={:?}",
        painted.pixel_width, painted.pixel_height, painted.height, painted.blocked, laid, t.elapsed()
    );
    // Composite over the app's ground so the PNG reads like the app
    let mut px = painted.rgba.clone();
    for p in px.chunks_mut(4) {
        let a = p[3] as u32;
        for (i, bg) in [0x15u32, 0x15, 0x15].iter().enumerate() {
            p[i] = (p[i] as u32 + bg * (255 - a) / 255).min(255) as u8;
        }
        p[3] = 255;
    }
    image::RgbaImage::from_raw(painted.pixel_width, painted.pixel_height, px).unwrap().save(&args[2])?;
    Ok(())
}
