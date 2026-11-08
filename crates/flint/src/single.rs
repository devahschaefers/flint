//! One Flint at a time. The GPUI app and the Electron app open the same
//! SQLite store, and two outbox workers draining one `ops` table could send a
//! message twice, so neither a second GPUI instance nor a running Electron
//! Flint is allowed alongside this one.

use std::fs::File;
use std::path::Path;
use std::process::Command;

/// Hold this for the life of the process (an OS lock next to the store)
pub struct InstanceLock(#[allow(dead_code)] File);

pub fn acquire(db_path: &Path) -> Result<InstanceLock, String> {
    let lock_path = db_path.with_extension("db.gpui.lock");
    let file = File::create(&lock_path).map_err(|e| format!("cannot create {}: {e}", lock_path.display()))?;
    file.try_lock().map_err(|_| "Flint is already running.".to_string())?;
    if let Some(cmd) = electron_flint_running() {
        return Err(format!("The Electron Flint app is running ({cmd}). Quit it first: both apps share one mailbox."));
    }
    Ok(InstanceLock(file))
}

/// The dev build (`…/Flint/…/Electron.app/…/Electron .`) or a packaged Flint.app
fn electron_flint_running() -> Option<String> {
    let out = Command::new("/bin/ps").args(["-axo", "command="]).output().ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find(|line| {
            let l = line.to_ascii_lowercase();
            let dev = l.contains("electron.app/contents/macos/electron") && l.contains("flint") && !l.contains("--type=");
            let packaged = l.contains("flint.app/contents/macos/flint");
            dev || packaged
        })
        .map(|l| l.chars().take(80).collect())
}
