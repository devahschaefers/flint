//! One Flint at a time: two outbox workers draining one `ops` table could
//! send a message twice, so a second copy refuses to start.

use std::fs::File;
use std::path::Path;

/// Hold this for the life of the process (an OS lock next to the store)
pub struct InstanceLock(#[allow(dead_code)] File);

pub fn acquire(db_path: &Path) -> Result<InstanceLock, String> {
    let lock_path = db_path.with_extension("db.gpui.lock");
    let file = File::create(&lock_path).map_err(|e| format!("cannot create {}: {e}", lock_path.display()))?;
    file.try_lock().map_err(|_| "Flint is already running.".to_string())?;
    Ok(InstanceLock(file))
}
