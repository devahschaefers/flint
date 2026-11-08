//! GPUI's HTTP client hook, used only to fetch remote images in mail the
//! reader chose to load ("Load images"). Plain GET over ureq on a short-lived
//! thread per request; anything that is not http(s) is refused.

use futures::future::BoxFuture;
use gpui_kit::http_client::{http, AsyncBody, HttpClient, Request, Response, Url};
use std::io::Read;

/// Images larger than this are not worth a mail view
const MAX_BYTES: u64 = 16 * 1024 * 1024;

pub struct ImageFetcher {
    agent: ureq::Agent,
}

impl ImageFetcher {
    pub fn new() -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(std::time::Duration::from_secs(20)))
            .http_status_as_error(false)
            .build();
        ImageFetcher { agent: config.into() }
    }
}

impl HttpClient for ImageFetcher {
    fn user_agent(&self) -> Option<&http::HeaderValue> {
        None
    }

    fn proxy(&self) -> Option<&Url> {
        None
    }

    fn send(&self, req: Request<AsyncBody>) -> BoxFuture<'static, anyhow::Result<Response<AsyncBody>>> {
        let uri = req.uri().to_string();
        let agent = self.agent.clone();
        let (tx, rx) = futures::channel::oneshot::channel();
        std::thread::spawn(move || {
            let result = (|| -> anyhow::Result<Response<AsyncBody>> {
                let lower = uri.to_ascii_lowercase();
                anyhow::ensure!(lower.starts_with("https://") || lower.starts_with("http://"), "refused non-web URL");
                let mut res = agent.get(&uri).call()?;
                let status = res.status().as_u16();
                let mut bytes = Vec::new();
                res.body_mut().as_reader().take(MAX_BYTES).read_to_end(&mut bytes)?;
                Ok(Response::builder().status(status).body(AsyncBody::from(bytes))?)
            })();
            let _ = tx.send(result);
        });
        Box::pin(async move { rx.await.map_err(|_| anyhow::anyhow!("image fetch dropped"))? })
    }
}
