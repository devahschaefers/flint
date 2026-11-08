//! The persisted outbox queue. Payloads are JSON with stable keys (`gmailIds`,
//! `action`, `value`, `messageIdHdr`, `gmailDraftId`, `gmailId`), since
//! operations already queued in the database must still drain.

use super::Db;
use crate::types::{OpKind, OpState, WireOp};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

pub fn op_kind_str(k: OpKind) -> &'static str {
    match k {
        OpKind::Action => "action",
        OpKind::Send => "send",
        OpKind::DraftPut => "draft_put",
        OpKind::DraftDelete => "draft_delete",
    }
}

fn parse_kind(s: &str) -> Option<OpKind> {
    Some(match s {
        "action" => OpKind::Action,
        "send" => OpKind::Send,
        "draft_put" => OpKind::DraftPut,
        "draft_delete" => OpKind::DraftDelete,
        _ => return None,
    })
}

fn parse_op_state(s: &str) -> OpState {
    match s {
        "running" => OpState::Running,
        "failed" => OpState::Failed,
        _ => OpState::Pending,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpRow {
    pub id: i64,
    pub account_id: String,
    pub kind: OpKind,
    pub payload: Value,
    pub state: OpState,
    pub attempts: i64,
    pub next_attempt_at: i64,
    pub last_error: Option<String>,
    pub created_at: i64,
}

impl OpRow {
    pub fn payload_str(&self, key: &str) -> Option<&str> {
        self.payload.get(key).and_then(Value::as_str)
    }

    pub fn payload_strings(&self, key: &str) -> Vec<String> {
        self.payload
            .get(key)
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    }

    pub fn to_wire(&self) -> WireOp {
        WireOp {
            id: self.id,
            account_id: self.account_id.clone(),
            kind: self.kind,
            state: self.state,
            attempts: self.attempts,
            last_error: self.last_error.clone(),
            next_attempt_at: self.next_attempt_at,
            created_at: self.created_at,
            message_id_hdr: self.payload_str("messageIdHdr").map(str::to_string),
            action: self.payload_str("action").map(str::to_string),
            gmail_ids: self.payload_strings("gmailIds"),
        }
    }
}

const OP_COLS: &str = "id, account_id, kind, payload, state, attempts, next_attempt_at, last_error, created_at";

/// Read op rows, skipping kinds this build does not know
fn query_ops(c: &Connection, tail: &str, p: impl rusqlite::Params) -> Result<Vec<OpRow>> {
    let mut stmt = c.prepare_cached(&format!("SELECT {OP_COLS} FROM ops {tail}"))?;
    let rows = stmt
        .query_map(p, |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, i64>(8)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, account_id, kind, payload, state, attempts, next_attempt_at, last_error, created_at)| {
            let Some(kind) = parse_kind(&kind) else {
                log::warn!("[db] op #{id} has unknown kind {kind:?}; ignored");
                return None;
            };
            Some(OpRow {
                id,
                account_id,
                kind,
                payload: serde_json::from_str(&payload).unwrap_or(Value::Object(Default::default())),
                state: parse_op_state(&state),
                attempts,
                next_attempt_at,
                last_error,
                created_at,
            })
        })
        .collect())
}

impl Db {
    pub fn enqueue_op<P: serde::Serialize>(&self, account_id: &str, kind: OpKind, payload: &P, run_at: Option<i64>) -> Result<i64> {
        let now = self.now();
        let json = super::messages::to_json(payload);
        self.write(|c| {
            c.execute(
                "INSERT INTO ops (account_id, kind, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)",
                params![account_id, op_kind_str(kind), json, run_at.unwrap_or(now), now],
            )?;
            Ok(c.last_insert_rowid())
        })
    }

    pub fn list_ops(&self) -> Result<Vec<OpRow>> {
        self.read(|c| query_ops(c, "ORDER BY id", []))
    }

    pub fn get_op(&self, id: i64) -> Result<Option<OpRow>> {
        self.read(|c| Ok(query_ops(c, "WHERE id = ?", [id])?.into_iter().next()))
    }

    /// Ops for one message (send/draft ops carry messageIdHdr in their payload)
    pub fn find_ops_for_message(&self, account_id: &str, hdr: &str) -> Result<Vec<OpRow>> {
        self.read(|c| {
            query_ops(
                c,
                "WHERE account_id = ? AND json_extract(payload, '$.messageIdHdr') = ? ORDER BY id",
                [account_id, hdr],
            )
        })
    }

    pub fn delete_op(&self, id: i64) -> Result<()> {
        self.write(|c| {
            c.execute("DELETE FROM ops WHERE id = ?", [id])?;
            Ok(())
        })
    }

    pub fn delete_ops(&self, ids: &[i64]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        self.write_tx(|tx| {
            let mut stmt = tx.prepare("DELETE FROM ops WHERE id = ?")?;
            for id in ids {
                stmt.execute([id])?;
            }
            Ok(())
        })
    }

    pub fn mark_op_running(&self, id: i64) -> Result<()> {
        self.write(|c| {
            c.execute("UPDATE ops SET state = 'running' WHERE id = ?", [id])?;
            Ok(())
        })
    }

    /// A transient failure: stay pending, back off
    pub fn defer_op(&self, id: i64, error: &str, next_attempt_at: i64) -> Result<()> {
        self.write(|c| {
            c.execute(
                "UPDATE ops SET state = 'pending', attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?",
                params![error, next_attempt_at, id],
            )?;
            Ok(())
        })
    }

    /// A permanent failure: park until the user retries or discards
    pub fn fail_op(&self, id: i64, error: &str) -> Result<()> {
        self.write(|c| {
            c.execute(
                "UPDATE ops SET state = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?",
                params![error, id],
            )?;
            Ok(())
        })
    }

    /// Put parked/deferred ops back on the front of the line (all when `ids` is None)
    pub fn retry_ops(&self, ids: Option<&[i64]>) -> Result<()> {
        let now = self.now();
        match ids {
            Some(ids) => self.write_tx(|tx| {
                let mut stmt = tx.prepare(
                    "UPDATE ops SET state = 'pending', next_attempt_at = ?, last_error = NULL WHERE id = ? AND state != 'running'",
                )?;
                for id in ids {
                    stmt.execute(params![now, id])?;
                }
                Ok(())
            }),
            None => self.write(|c| {
                c.execute(
                    "UPDATE ops SET state = 'pending', next_attempt_at = ?, last_error = NULL WHERE state != 'running'",
                    [now],
                )?;
                Ok(())
            }),
        }
    }

    /// Ops that were mid-flight when the process died, now pending again
    pub fn reset_running_ops(&self) -> Result<Vec<OpRow>> {
        self.write_tx(|tx| {
            let rows = query_ops(tx, "WHERE state = 'running'", [])?;
            tx.execute("UPDATE ops SET state = 'pending' WHERE state = 'running'", [])?;
            Ok(rows)
        })
    }

    /// Does this op still exist? (test aid)
    pub fn has_op(&self, id: i64) -> Result<bool> {
        self.read(|c| Ok(c.query_row("SELECT 1 FROM ops WHERE id = ?", [id], |_| Ok(())).optional()?.is_some()))
    }
}
