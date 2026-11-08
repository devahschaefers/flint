//! Bundled assets: the three strip glyphs from the design, with GPUI Kit's
//! icon set behind them for anything the components ask for.

use gpui_kit::{AssetSource, Result, SharedString};
use std::borrow::Cow;

pub struct Assets;

const OWN: &[(&str, &[u8])] = &[
    ("icons/filter.svg", include_bytes!("../assets/icons/filter.svg")),
    ("icons/search.svg", include_bytes!("../assets/icons/search.svg")),
    ("icons/compose.svg", include_bytes!("../assets/icons/compose.svg")),
];

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if let Some((_, bytes)) = OWN.iter().find(|(p, _)| *p == path) {
            return Ok(Some(Cow::Borrowed(bytes)));
        }
        gpui_kit::assets::Assets.load(path)
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut out: Vec<SharedString> =
            OWN.iter().filter(|(p, _)| p.starts_with(path)).map(|(p, _)| (*p).into()).collect();
        out.extend(gpui_kit::assets::Assets.list(path)?);
        Ok(out)
    }
}
