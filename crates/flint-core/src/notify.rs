//! "The local store changed" push to the UI (port of `src/main/notify.ts`).
//! Sync traffic is throttled (trailing edge) so backfill pages don't spam the
//! UI; user-initiated writes go out immediately.

use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::runtime::Handle;

const THROTTLE_MS: u64 = 800;

type Callback = Arc<dyn Fn() + Send + Sync>;

#[derive(Default)]
struct Timer {
    armed: bool,
    /// Bumped whenever an armed timer is cancelled, so its task fires nothing
    generation: u64,
}

pub struct Notifier {
    cb: Callback,
    timer: Arc<Mutex<Timer>>,
    /// Where the trailing-edge timer runs; None sends throttled pings immediately
    handle: Option<Handle>,
}

impl Notifier {
    pub fn new(cb: impl Fn() + Send + Sync + 'static, handle: Option<Handle>) -> Notifier {
        Notifier { cb: Arc::new(cb), timer: Arc::default(), handle }
    }

    /// A notifier nobody listens to
    pub fn noop() -> Notifier {
        Notifier::new(|| {}, None)
    }

    pub fn mail_changed(&self, immediate: bool) {
        if immediate {
            {
                let mut t = self.timer.lock().unwrap();
                if t.armed {
                    t.armed = false;
                    t.generation += 1;
                }
            }
            (self.cb)();
            return;
        }
        let Some(handle) = &self.handle else {
            (self.cb)();
            return;
        };
        let generation = {
            let mut t = self.timer.lock().unwrap();
            if t.armed {
                return;
            }
            t.armed = true;
            t.generation
        };
        let timer = self.timer.clone();
        let cb = self.cb.clone();
        handle.spawn(async move {
            tokio::time::sleep(Duration::from_millis(THROTTLE_MS)).await;
            let fire = {
                let mut t = timer.lock().unwrap();
                let fire = t.armed && t.generation == generation;
                if fire {
                    t.armed = false;
                }
                fire
            };
            if fire {
                cb();
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test(start_paused = true)]
    async fn throttles_sync_pings_and_sends_user_writes_at_once() {
        let n = Arc::new(AtomicUsize::new(0));
        let c = n.clone();
        let notifier = Notifier::new(move || { c.fetch_add(1, Ordering::SeqCst); }, Some(Handle::current()));
        notifier.mail_changed(false);
        notifier.mail_changed(false);
        notifier.mail_changed(false);
        assert_eq!(n.load(Ordering::SeqCst), 0);
        tokio::time::sleep(Duration::from_millis(900)).await;
        assert_eq!(n.load(Ordering::SeqCst), 1);

        // An immediate ping cancels the pending trailing one
        notifier.mail_changed(false);
        notifier.mail_changed(true);
        assert_eq!(n.load(Ordering::SeqCst), 2);
        tokio::time::sleep(Duration::from_millis(900)).await;
        assert_eq!(n.load(Ordering::SeqCst), 2);
    }
}
