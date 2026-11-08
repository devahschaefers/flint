//! Background body compaction.
//! Rows on a stale codec are re-encoded a batch at a time on a timer.
//! Nothing is remembered between runs: each batch asks the store what is
//! left, so the job is resumable across restarts and idempotent. It stops
//! itself once a batch finds nothing left.

use crate::db::{CompactBatch, Db};
use anyhow::Result;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JobStatus {
    /// Timer armed or a batch in flight
    pub running: bool,
    /// Rows still to do (as of the last batch, or the start check)
    pub remaining: u64,
    /// Rows done since start()
    pub processed: u64,
    pub bytes_before: u64,
    pub bytes_after: u64,
    pub text_derived: u64,
    /// Set when a batch failed; the job stops on error
    pub error: Option<String>,
}

type BatchFn = Arc<dyn Fn(usize) -> Result<CompactBatch> + Send + Sync>;
type CountFn = Arc<dyn Fn() -> Result<u64> + Send + Sync>;
type LogFn = Arc<dyn Fn(&str) + Send + Sync>;

pub struct CompactorOptions {
    pub batch_size: usize,
    pub interval: Duration,
    pub initial_delay: Duration,
    pub log_every: Duration,
    pub run_batch: BatchFn,
    pub count_remaining: CountFn,
    pub log: LogFn,
}

impl CompactorOptions {
    /// The defaults over a store: 200 rows per batch, 250 ms apart, 5 s initial delay
    pub fn for_db(db: Arc<Db>) -> CompactorOptions {
        let d1 = db.clone();
        CompactorOptions {
            batch_size: 200,
            interval: Duration::from_millis(250),
            initial_delay: Duration::from_secs(5),
            log_every: Duration::from_secs(5),
            run_batch: Arc::new(move |limit| d1.compact_bodies_batch(limit)),
            count_remaining: Arc::new(move || Ok(db.count_uncompacted()? as u64)),
            log: Arc::new(|line| log::info!("{line}")),
        }
    }
}

fn mb(bytes: u64) -> String {
    format!("{:.1}", bytes as f64 / 1_048_576.0)
}

struct Inner {
    opts: CompactorOptions,
    status: Mutex<JobStatus>,
    last_log: Mutex<Option<Instant>>,
    task: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct Compactor {
    inner: Arc<Inner>,
}

impl Compactor {
    pub fn new(opts: CompactorOptions) -> Compactor {
        Compactor {
            inner: Arc::new(Inner {
                opts,
                status: Mutex::default(),
                last_log: Mutex::default(),
                task: Mutex::default(),
            }),
        }
    }

    fn record(&self, b: &CompactBatch) {
        let mut s = self.inner.status.lock().unwrap();
        s.processed += b.processed;
        s.bytes_before += b.bytes_before;
        s.bytes_after += b.bytes_after;
        s.text_derived += b.text_derived;
        s.remaining = b.remaining;
    }

    fn progress(&self, fin: bool) {
        {
            let mut last = self.inner.last_log.lock().unwrap();
            let now = Instant::now();
            if !fin && last.is_some_and(|l| now.duration_since(l) < self.inner.opts.log_every) {
                return;
            }
            *last = Some(now);
        }
        let s = self.status();
        let ratio = if s.bytes_before > 0 { s.bytes_after as f64 / s.bytes_before as f64 * 100.0 } else { 0.0 };
        let derived = if s.text_derived > 0 {
            format!("; text derived from HTML for {}", s.text_derived)
        } else {
            String::new()
        };
        (self.inner.opts.log)(&format!(
            "[compactor] {}{} rows, {} left; {} MB → {} MB ({ratio:.0}%){derived}",
            if fin { "done: " } else { "" },
            s.processed,
            s.remaining,
            mb(s.bytes_before),
            mb(s.bytes_after),
        ));
    }

    /// One timer tick: true when another should follow
    fn tick(&self) -> bool {
        let batch = match (self.inner.opts.run_batch)(self.inner.opts.batch_size) {
            Ok(b) => b,
            Err(e) => {
                let msg = e.to_string();
                {
                    let mut s = self.inner.status.lock().unwrap();
                    s.error = Some(msg.clone());
                    s.running = false;
                }
                (self.inner.opts.log)(&format!("[compactor] stopped on error: {msg}"));
                return false;
            }
        };
        self.record(&batch);
        if batch.remaining == 0 {
            self.inner.status.lock().unwrap().running = false;
            self.progress(true);
            return false;
        }
        self.progress(false);
        true
    }

    /// Arm the timer on `handle` (no-op while running or when nothing is left)
    pub fn start(&self, handle: &Handle) {
        let remaining = {
            let mut s = self.inner.status.lock().unwrap();
            if s.running {
                return;
            }
            s.error = None;
            drop(s);
            let remaining = match (self.inner.opts.count_remaining)() {
                Ok(n) => n,
                Err(e) => {
                    (self.inner.opts.log)(&format!("[compactor] could not count rows: {e}"));
                    return;
                }
            };
            let mut s = self.inner.status.lock().unwrap();
            s.remaining = remaining;
            if remaining == 0 {
                drop(s);
                (self.inner.opts.log)("[compactor] nothing to compact");
                return;
            }
            s.running = true;
            remaining
        };
        (self.inner.opts.log)(&format!(
            "[compactor] {remaining} rows to compact, {} per batch",
            self.inner.opts.batch_size
        ));
        let me = self.clone();
        let task = handle.spawn(async move {
            tokio::time::sleep(me.inner.opts.initial_delay).await;
            loop {
                // A batch is one short write transaction; run it off the async workers
                let m = me.clone();
                let more = tokio::task::spawn_blocking(move || m.tick()).await.unwrap_or(false);
                if !more {
                    return;
                }
                tokio::time::sleep(me.inner.opts.interval).await;
            }
        });
        *self.inner.task.lock().unwrap() = Some(task);
    }

    pub fn stop(&self) {
        if let Some(t) = self.inner.task.lock().unwrap().take() {
            t.abort();
        }
        self.inner.status.lock().unwrap().running = false;
    }

    pub fn status(&self) -> JobStatus {
        self.inner.status.lock().unwrap().clone()
    }

    /// Run one batch now (tests, or a manual nudge)
    pub fn run_once(&self) -> Result<CompactBatch> {
        let b = (self.inner.opts.run_batch)(self.inner.opts.batch_size)?;
        self.record(&b);
        Ok(b)
    }

    /// Run batches back to back until nothing is left
    pub fn run_to_completion(&self) -> Result<u64> {
        let mut total = 0;
        loop {
            let b = (self.inner.opts.run_batch)(self.inner.opts.batch_size)?;
            self.record(&b);
            total += b.processed;
            if b.remaining == 0 || b.processed == 0 {
                return Ok(total);
            }
        }
    }
}
