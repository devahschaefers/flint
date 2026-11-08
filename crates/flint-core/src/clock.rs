//! Wall-clock source (unix ms). Injected so tests can step through undo
//! windows and backoff the way the TS suites fake `Date`.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
    }
}

pub fn system() -> Arc<dyn Clock> {
    Arc::new(SystemClock)
}

/// A clock that only moves when told to
#[derive(Default)]
pub struct ManualClock {
    now: AtomicI64,
}

impl ManualClock {
    pub fn new(start_ms: i64) -> Arc<ManualClock> {
        Arc::new(ManualClock { now: AtomicI64::new(start_ms) })
    }

    pub fn advance(&self, ms: i64) {
        self.now.fetch_add(ms, Ordering::SeqCst);
    }

    pub fn set(&self, ms: i64) {
        self.now.store(ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
}
