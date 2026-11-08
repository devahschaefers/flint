//! Mail HTML rendering for the GPUI app, on Blitz (Stylo CSS, Taffy layout,
//! Parley text) painted to pixels with vello_cpu.
//!
//! The app shows the result as an image, so scrolling, clipping and every
//! overlay keep working as plain GPUI. A [`MailDocument`] stays alive after
//! painting so clicks can be hit-tested against the real layout.
//!
//! Safety: Blitz runs no scripts and fetches nothing on its own; every
//! resource request goes through [`MailNet`], which only answers `data:` URLs
//! unless remote images were allowed for this message, and counts what it
//! refused (tracking pixels, remote images, remote stylesheets and fonts).

use anyhow::Result;
use blitz_dom::{BaseDocument, DocumentConfig, UserAgentStylesheet};
use blitz_html::HtmlDocument;
use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request};
use blitz_traits::shell::{ColorScheme, Viewport};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Fetches a remote resource when remote content is allowed (http/https only)
pub type Fetcher = Arc<dyn Fn(&str) -> Option<Vec<u8>> + Send + Sync>;

pub struct RenderOptions {
    /// Layout width in CSS pixels (the message column)
    pub width: f32,
    /// Device pixels per CSS pixel (screen scale × interface zoom)
    pub scale: f32,
    /// Extra user-agent CSS (the app's look for unstyled mail)
    pub stylesheet: String,
    /// When set, remote images and stylesheets are fetched with it
    pub fetch: Option<Fetcher>,
}

pub struct Painted {
    /// Premultiplied RGBA, `pixel_width × pixel_height`
    pub rgba: Vec<u8>,
    pub pixel_width: u32,
    pub pixel_height: u32,
    /// Content height in CSS pixels
    pub height: f32,
    /// Painted width in CSS pixels: the column, or more for mail that overflows it
    pub content_width: f32,
    /// Remote resources refused (0 when remote content was allowed)
    pub blocked: usize,
}

/// Answers `data:` URLs itself; everything else only through the fetcher
struct MailNet {
    fetch: Option<Fetcher>,
    blocked: AtomicUsize,
}

impl NetProvider for MailNet {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let url = request.url.as_str().to_string();
        let bytes = match request.url.scheme() {
            "data" => decode_data_url(&url),
            "http" | "https" => match &self.fetch {
                Some(fetch) => fetch(&url),
                None => {
                    self.blocked.fetch_add(1, Ordering::Relaxed);
                    None
                }
            },
            _ => None,
        };
        if let Some(bytes) = bytes {
            handler.bytes(url, Bytes::from(bytes));
        }
    }
}

/// `data:[<mime>][;base64],<payload>`
fn decode_data_url(url: &str) -> Option<Vec<u8>> {
    let rest = url.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    if meta.ends_with(";base64") {
        base64_decode(payload)
    } else {
        Some(percent_decode(payload))
    }
}

fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' | b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return None,
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

/// Widest body painted, in CSS pixels, so a hostile width can't exhaust memory
const MAX_CONTENT_WIDTH: f32 = 4000.0;

/// A laid-out message body
pub struct MailDocument {
    doc: HtmlDocument,
    net: Arc<MailNet>,
    width: f32,
    scale: f32,
}

impl MailDocument {
    pub fn new(html: &str, opts: &RenderOptions) -> Result<MailDocument> {
        let net = Arc::new(MailNet { fetch: opts.fetch.clone(), blocked: AtomicUsize::new(0) });
        let viewport = viewport(opts.width, 1.0, opts.scale);
        let config = DocumentConfig {
            viewport: Some(viewport),
            ua_stylesheets: vec![
                UserAgentStylesheet::default_sheet(),
                UserAgentStylesheet::parse(&opts.stylesheet),
            ],
            net_provider: Some(net.clone() as Arc<dyn NetProvider>),
            ..Default::default()
        };
        let mut doc = HtmlDocument::from_html(html, config);
        let base: &mut BaseDocument = &mut doc;
        base.handle_messages();
        base.resolve(0.0);
        let mut this = MailDocument { doc, net, width: opts.width, scale: opts.scale };
        // Lay out against the content height so nothing is clipped
        let h = this.height();
        this.set_viewport_height(h);
        Ok(this)
    }

    fn base(&mut self) -> &mut BaseDocument {
        &mut self.doc
    }

    fn set_viewport_height(&mut self, height: f32) {
        let vp = viewport(self.width, height.max(1.0), self.scale);
        let base = self.base();
        base.set_viewport(vp);
        base.resolve(0.0);
    }

    /// Content height in CSS pixels
    pub fn height(&self) -> f32 {
        let base: &BaseDocument = &self.doc;
        let root = base.root_element();
        let layout = root.final_layout();
        (layout.size.height + layout.margin.top + layout.margin.bottom).max(1.0).ceil()
    }

    /// Width to paint in CSS pixels. Layout stays at the column width so mail
    /// that can reflow does; fixed-width mail that overflows gets the rest.
    pub fn content_width(&self) -> f32 {
        let base: &BaseDocument = &self.doc;
        let layout = base.root_element().final_layout();
        let right = layout.size.width.max(layout.scrollable_overflow_rect.right);
        if right <= self.width + 1.0 {
            self.width
        } else {
            right.ceil().min(MAX_CONTENT_WIDTH)
        }
    }

    pub fn blocked(&self) -> usize {
        self.net.blocked.load(Ordering::Relaxed)
    }

    pub fn paint(&mut self) -> Painted {
        let height = self.height();
        let content_width = self.content_width();
        let pw = (content_width * self.scale).ceil().max(1.0) as u32;
        let ph = (height * self.scale).ceil().max(1.0) as u32;
        let scale = self.scale as f64;
        let base = self.base();
        let rgba = anyrender::render_to_buffer::<anyrender_vello_cpu::VelloCpuImageRenderer, _>(
            |scene| blitz_paint::paint_scene(scene, base, scale, pw, ph, 0, 0),
            pw,
            ph,
        );
        Painted { rgba, pixel_width: pw, pixel_height: ph, height, content_width, blocked: self.blocked() }
    }

    /// The link under a point (CSS pixels from the body's top-left), if any
    pub fn link_at(&self, x: f32, y: f32) -> Option<String> {
        let base: &BaseDocument = &self.doc;
        let hit = base.hit(x, y)?;
        let mut node = base.get_node(hit.node_id);
        while let Some(n) = node {
            if let Some(el) = n.element_data() {
                if &*el.name.local == "a" {
                    if let Some(href) = el.attrs().iter().find(|a| &*a.name.local == "href") {
                        return Some(href.value.to_string());
                    }
                }
            }
            node = n.parent.and_then(|p| base.get_node(p));
        }
        None
    }
}

fn viewport(width: f32, height: f32, scale: f32) -> Viewport {
    Viewport::new(
        (width * scale).ceil() as u32,
        (height * scale).ceil() as u32,
        scale,
        ColorScheme::Dark,
    )
}

// ---------- worker ----------

/// Documents are not `Send` (Blitz holds thread-local pieces), so they live
/// on one renderer thread. The UI asks it to render and hit-test by id and
/// drops documents it no longer shows.
#[derive(Clone)]
pub struct HtmlWorker {
    tx: std::sync::mpsc::Sender<Job>,
}

enum Job {
    Render { id: u64, html: String, opts: RenderOptions, reply: std::sync::mpsc::Sender<Result<Painted>> },
    LinkAt { id: u64, x: f32, y: f32, reply: std::sync::mpsc::Sender<Option<String>> },
    Drop { id: u64 },
}

impl HtmlWorker {
    pub fn spawn() -> HtmlWorker {
        let (tx, rx) = std::sync::mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("mail-html".into())
            .spawn(move || {
                let mut docs: std::collections::HashMap<u64, MailDocument> = std::collections::HashMap::new();
                for job in rx {
                    match job {
                        Job::Render { id, html, opts, reply } => {
                            let result = MailDocument::new(&html, &opts).map(|mut doc| {
                                let painted = doc.paint();
                                docs.insert(id, doc);
                                painted
                            });
                            let _ = reply.send(result);
                        }
                        Job::LinkAt { id, x, y, reply } => {
                            let _ = reply.send(docs.get(&id).and_then(|d| d.link_at(x, y)));
                        }
                        Job::Drop { id } => {
                            docs.remove(&id);
                        }
                    }
                }
            })
            .expect("spawn mail-html thread");
        HtmlWorker { tx }
    }

    /// Lay out and paint; blocks until done. Replaces any document under `id`.
    pub fn render(&self, id: u64, html: String, opts: RenderOptions) -> Result<Painted> {
        let (reply, rx) = std::sync::mpsc::channel();
        self.tx.send(Job::Render { id, html, opts, reply }).map_err(|_| anyhow::anyhow!("html worker gone"))?;
        rx.recv().map_err(|_| anyhow::anyhow!("html worker gone"))?
    }

    /// The link under a point of a rendered document (CSS pixels); blocks
    pub fn link_at(&self, id: u64, x: f32, y: f32) -> Option<String> {
        let (reply, rx) = std::sync::mpsc::channel();
        self.tx.send(Job::LinkAt { id, x, y, reply }).ok()?;
        rx.recv().ok().flatten()
    }

    pub fn drop_document(&self, id: u64) {
        let _ = self.tx.send(Job::Drop { id });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> RenderOptions {
        RenderOptions { width: 400.0, scale: 1.0, stylesheet: String::new(), fetch: None }
    }

    #[test]
    fn renders_and_hits_links() {
        let worker = HtmlWorker::spawn();
        let painted = worker
            .render(1, "<p style='margin:0'><a href='https://x.example/a' style='font-size:20px'>link</a></p><p>after</p>".into(), opts())
            .unwrap();
        assert!(painted.height > 20.0 && painted.pixel_width == 400);
        assert_eq!(worker.link_at(1, 10.0, 10.0).as_deref(), Some("https://x.example/a"));
        assert_eq!(worker.link_at(1, 300.0, 10.0), None);
        worker.drop_document(1);
        assert_eq!(worker.link_at(1, 10.0, 10.0), None);
    }

    #[test]
    fn blocks_remote_images_without_a_fetcher() {
        let worker = HtmlWorker::spawn();
        let painted = worker.render(2, "<img src='https://t.example/p.gif' width=1 height=1><p>hi</p>".into(), opts()).unwrap();
        assert_eq!(painted.blocked, 1);
    }

    #[test]
    fn paints_fixed_width_mail_past_the_column() {
        let worker = HtmlWorker::spawn();
        let html = "<body style='margin:0'><div style='width:1800px;height:20px;background:#ff0000'></div></body>";
        let painted = worker.render(3, html.into(), opts()).unwrap();
        assert_eq!(painted.content_width, 1800.0);
        assert_eq!(painted.pixel_width, 1800);
        assert_eq!(painted.rgba[1700 * 4], 255, "the part past the column is painted");
    }

    #[test]
    fn data_urls() {
        assert_eq!(decode_data_url("data:text/plain;base64,aGk=").unwrap(), b"hi");
        assert_eq!(decode_data_url("data:,a%20b").unwrap(), b"a b");
    }
}

