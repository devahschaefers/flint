//! Flint, the GPUI build. Same mailbox as the Electron app (it opens the same
//! SQLite store), drawn natively. Never run both apps at once: they would
//! both sync and both drain the outbox.

mod app;
mod assets;
mod theme;
mod util;
mod views;

use app::FlintApp;
use flint_core::{Engine, Store};
use gpui_kit::*;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let path = Store::default_path();
    let store = match Store::open(&path) {
        Ok(store) => store,
        Err(err) => {
            eprintln!("Flint could not open its mail store at {}: {err:#}", path.display());
            std::process::exit(1);
        }
    };
    let (tx, rx) = futures::channel::mpsc::unbounded::<()>();
    let engine = Engine::start(store, move || {
        let _ = tx.unbounded_send(());
    });

    gpui_kit::application().with_assets(assets::Assets).run(move |cx: &mut App| {
        gpui_kit::init(cx);
        app::bind_keys(cx);
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        let bounds = Bounds::centered(None, size(px(1440.), px(900.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(800.), px(600.))),
            titlebar: Some(TitlebarOptions {
                title: Some("Flint".into()),
                appears_transparent: true,
                // The lights sit in the window's top-left margin, above the strip
                traffic_light_position: Some(point(px(20.), px(18.))),
            }),
            window_background: WindowBackgroundAppearance::Opaque,
            ..Default::default()
        };
        let mut changes = Some(rx);
        gpui_kit::open_window(options, cx, |window, cx| {
            let rx = changes.take().expect("one window");
            let engine = engine.clone();
            cx.new(|cx| FlintApp::new(engine, rx, window, cx))
        })
        .expect("open window");
        cx.activate(true);
    });
}
