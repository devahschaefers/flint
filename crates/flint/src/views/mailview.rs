//! A message's text/html part, rendered by flint-html (Blitz) on its worker
//! thread and shown as an image. Unstyled mail gets the app's reading look
//! from a user-agent stylesheet (the old `.rt` rules); mail that styles
//! itself keeps its own design, as it did in the Electron app.
//!
//! Each body renders at its column width × (screen scale × zoom), again
//! when that changes, and again when the reader loads remote images. Clicks
//! are hit-tested against the live document; only web links and mailto
//! reach the OS.

use crate::app::*;
use crate::theme::*;
use crate::zoom::px;
use flint_html::{Fetcher, HtmlWorker, RenderOptions};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use std::cell::Cell;
use std::io::Read;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// The reading look for mail that brings no styles of its own. Colors stay
/// off elements that commonly sit on a sender's own (light) background.
const STYLESHEET: &str = r#"
html, body { margin: 0; padding: 0; background: transparent; }
body {
  font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  font-size: 14px; line-height: 1.7; color: #cccccc;
  overflow-wrap: break-word;
}
p { margin: 0 0 10px; }
h1, h2 { margin: 14px 0 8px; font-size: 18px; font-weight: 600; }
h3 { margin: 12px 0 6px; font-size: 15px; font-weight: 600; }
ul, ol { margin: 0 0 10px; padding-left: 22px; }
blockquote { margin: 0 0 10px; border-left: 2px solid #6f9df0; padding-left: 12px; color: #888888; }
pre {
  margin: 0 0 10px; border: 1px solid #2a2a2a; border-radius: 8px; background: #151515;
  padding: 10px 12px; font-family: Menlo, monospace; font-size: 12.5px; white-space: pre-wrap;
}
code { font-family: Menlo, monospace; font-size: 12.5px; }
a, a[href] { color: #6f9df0; text-decoration: none; }
img { max-width: 100%; height: auto; }
table { max-width: 100%; }
"#;

static NEXT_DOC: AtomicU64 = AtomicU64::new(1);

/// What a body was (or is being) rendered at
#[derive(Clone, Copy, PartialEq)]
struct Target {
    width: f32,
    scale: f32,
    allow_images: bool,
}

impl Target {
    fn close_to(&self, other: &Target) -> bool {
        (self.width - other.width).abs() < 1.0 && (self.scale - other.scale).abs() < 0.01 && self.allow_images == other.allow_images
    }
}

pub struct HtmlBody {
    doc_id: u64,
    html: Arc<str>,
    image: Option<Arc<RenderImage>>,
    /// Rendered content height, CSS px
    height: f32,
    /// Painted width, CSS px (past the column when the mail is fixed-width)
    content_width: f32,
    blocked: usize,
    shown: Option<Target>,
    in_flight: Option<Target>,
    failed: bool,
    /// Where the image was last painted, for click hit-testing
    bounds: Rc<Cell<Bounds<Pixels>>>,
}

impl HtmlBody {
    pub fn new(html: &str) -> Self {
        HtmlBody {
            doc_id: NEXT_DOC.fetch_add(1, Ordering::Relaxed),
            html: html.into(),
            image: None,
            height: 0.0,
            content_width: 0.0,
            blocked: 0,
            shown: None,
            in_flight: None,
            failed: false,
            bounds: Rc::new(Cell::new(Bounds::default())),
        }
    }

    pub fn doc_id(&self) -> u64 {
        self.doc_id
    }

    pub fn blocked(&self) -> usize {
        self.blocked
    }

    pub fn failed(&self) -> bool {
        self.failed
    }
}

fn image_fetcher() -> Fetcher {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(15)))
        .build()
        .into();
    Arc::new(move |url: &str| {
        let lower = url.to_ascii_lowercase();
        if !(lower.starts_with("https://") || lower.starts_with("http://")) {
            return None;
        }
        let mut res = agent.get(url).call().ok()?;
        let mut bytes = Vec::new();
        res.body_mut().as_reader().take(16 * 1024 * 1024).read_to_end(&mut bytes).ok()?;
        Some(bytes)
    })
}

/// vello_cpu's premultiplied RGBA → GPUI's straight BGRA frame
fn to_render_image(mut rgba: Vec<u8>, width: u32, height: u32) -> Option<Arc<RenderImage>> {
    for p in rgba.as_chunks_mut::<4>().0 {
        let a = p[3] as u32;
        if a > 0 && a < 255 {
            for c in &mut p[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
        p.swap(0, 2);
    }
    let buffer = image::RgbaImage::from_raw(width, height, rgba)?;
    Some(Arc::new(RenderImage::new(vec![image::Frame::new(buffer)])))
}

impl FlintApp {
    /// Width of a message body column in logical pixels: the page minus its
    /// margins, minus the avatar and its gap
    pub fn body_width(&self, window: &Window) -> Pixels {
        let page = window.viewport_size().width;
        (page - self.page_left_gutter() - page * 0.09 - px(40.)).max(gpui_kit::px(200.))
    }

    /// Kick a render when the body is missing or stale for `target`
    fn ensure_html(&mut self, key: &str, target: Target, cx: &mut Context<Self>) {
        let worker = self.html.clone();
        let Some(body) = self.html_body_mut(key) else { return };
        if body.failed || body.in_flight.is_some() || body.shown.is_some_and(|s| s.close_to(&target)) {
            return;
        }
        body.in_flight = Some(target);
        let (doc_id, html) = (body.doc_id, body.html.clone());
        let key = key.to_string();
        let task = cx.background_spawn(async move {
            let opts = RenderOptions {
                width: target.width,
                scale: target.scale,
                stylesheet: STYLESHEET.to_string(),
                fetch: target.allow_images.then(image_fetcher),
            };
            worker.render(doc_id, html.to_string(), opts).map(|p| {
                let image = to_render_image(p.rgba, p.pixel_width, p.pixel_height);
                (image, p.height, p.content_width, p.blocked)
            })
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                let Some(body) = this.html_body_mut(&key) else { return };
                body.in_flight = None;
                match result {
                    Ok((Some(image), height, content_width, blocked)) => {
                        body.image = Some(image);
                        body.height = height;
                        body.content_width = content_width;
                        body.blocked = blocked;
                        body.shown = Some(target);
                    }
                    Ok((None, ..)) => body.failed = true,
                    Err(err) => {
                        log::error!("mail html render failed: {err:#}");
                        body.failed = true;
                    }
                }
                // A resize or zoom during the render is picked up on this re-render
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The rendered body, or None while its first render is in flight (the
    /// caller shows the plain text meanwhile)
    pub fn html_body(&mut self, key: &str, allow_images: bool, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let width = self.body_width(window);
        let zoom = crate::zoom::zoom();
        let target = Target { width: f32::from(width) / zoom, scale: window.scale_factor() * zoom, allow_images };
        self.ensure_html(key, target, cx);

        let worker = self.html.clone();
        let body = self.html_body_mut(key)?;
        let image = body.image.clone()?;
        let shown = body.shown?;
        // Keep the last frame up (stretched to the new width) until its re-render lands
        let stretch = (f32::from(width) / (shown.width * zoom)).max(0.01);
        let logical_h = gpui_kit::px(body.height * zoom * stretch);
        let logical_w = gpui_kit::px(body.content_width * zoom * stretch);
        let bounds = body.bounds.clone();
        let paint_bounds = bounds.clone();
        let doc_id = body.doc_id;
        let rendered_width = body.content_width;
        let overflows = body.content_width > shown.width;

        let page = div()
                .id(("mail-html", doc_id as usize))
                .relative()
                .w(logical_w)
                .h(logical_h)
                .child(img(ImageSource::Render(image)).size_full())
                .child(
                    canvas(move |b, _, _| paint_bounds.set(b), |_, _, _, _| {})
                        .absolute()
                        .inset_0(),
                )
                .on_click(cx.listener(move |_, ev: &ClickEvent, _, cx| {
                    let b = bounds.get();
                    let pos = ev.position();
                    let factor = rendered_width / f32::from(b.size.width).max(1.0);
                    let x = f32::from(pos.x - b.origin.x) * factor;
                    let y = f32::from(pos.y - b.origin.y) * factor;
                    let worker = worker.clone();
                    let hit = cx.background_spawn(async move { worker.link_at(doc_id, x, y) });
                    cx.spawn(async move |_, cx| {
                        let Some(url) = hit.await else { return };
                        // Mail HTML is attacker-controlled: only web links and mailto reach the OS
                        let lower = url.to_ascii_lowercase();
                        if lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:") {
                            cx.update(|cx| cx.open_url(&url));
                        } else {
                            log::warn!("dropped link: {url}");
                        }
                    })
                    .detach();
                }));

        // Restricted to its axis, or GPUI would turn vertical wheel movement
        // over wide mail into sideways scrolling and strand the page
        Some(
            div()
                .id(("mail-html-scroll", doc_id as usize))
                .w(width)
                .when(overflows, |d| d.overflow_x_scroll().restrict_scroll_to_axis())
                .child(page)
                .into_any_element(),
        )
    }

    /// A dim stand-in while the first render is in flight
    pub fn html_placeholder(&self) -> Div {
        div().h(px(24.)).text_size(px(12.)).text_color(c(HINT)).child("…")
    }
}

/// Free a thread's documents on the worker when the thread view goes away
pub fn release(worker: &HtmlWorker, bodies: impl Iterator<Item = u64>) {
    for id in bodies {
        worker.drop_document(id);
    }
}

