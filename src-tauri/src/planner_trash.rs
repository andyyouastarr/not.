//! Retention applies to tasks only. Attachments and independent backups are not erased.
use crate::{crypto::Result, vault::Vault};
use rusqlite::{params, Connection};

fn sql<T>(result: rusqlite::Result<T>) -> Result<T> {
    result.map_err(|_| "Не удалось обработать корзину Планера".into())
}

pub fn schema(conn: &Connection) -> Result<()> {
    sql(conn.execute_batch("CREATE TABLE IF NOT EXISTS planner_trash(
        task_id TEXT PRIMARY KEY REFERENCES planner_tasks(id), deleted_at INTEGER NOT NULL CHECK(deleted_at>=0));
        CREATE INDEX IF NOT EXISTS planner_trash_expiry ON planner_trash(deleted_at);
        INSERT OR IGNORE INTO planner_trash SELECT id,CAST(strftime('%s','now') AS INTEGER) FROM planner_tasks WHERE json_extract(payload,'$.deleted')=1;
        CREATE TRIGGER IF NOT EXISTS planner_trash_insert AFTER INSERT ON planner_tasks
        WHEN json_extract(NEW.payload,'$.deleted')=1 BEGIN
          INSERT INTO planner_trash VALUES(NEW.id,CAST(strftime('%s','now') AS INTEGER)); END;
        CREATE TRIGGER IF NOT EXISTS planner_trash_delete AFTER UPDATE OF payload ON planner_tasks
        WHEN json_extract(NEW.payload,'$.deleted')=1 AND json_extract(OLD.payload,'$.deleted')=0 BEGIN
          INSERT OR REPLACE INTO planner_trash VALUES(NEW.id,CAST(strftime('%s','now') AS INTEGER)); END;
        CREATE TRIGGER IF NOT EXISTS planner_trash_restore AFTER UPDATE OF payload ON planner_tasks
        WHEN json_extract(NEW.payload,'$.deleted')=0 BEGIN
          DELETE FROM planner_trash WHERE task_id=NEW.id; END;"))
}

impl Vault {
    pub fn validate_planner_trash(&self) -> Result<()> {
        let count: i64 = sql(self.conn.query_row("SELECT count(*) FROM planner_tasks t LEFT JOIN planner_trash x ON x.task_id=t.id WHERE (json_extract(t.payload,'$.deleted')=1 AND x.task_id IS NULL) OR (json_extract(t.payload,'$.deleted')=0 AND x.task_id IS NOT NULL)", [], |r|r.get(0)))?;
        let invalid: i64 = sql(self.conn.query_row("SELECT count(*) FROM planner_trash x LEFT JOIN planner_tasks t ON x.task_id=t.id WHERE t.id IS NULL OR typeof(x.deleted_at)!='integer' OR x.deleted_at<0", [], |r|r.get(0)))?;
        if count != 0 || invalid != 0 {
            return Err("Повреждены сроки хранения корзины".into());
        }
        Ok(())
    }

    // Run before exposing any diary document to the UI, avoiding stale editor revisions.
    pub fn purge_planner_trash(&self, now: i64) -> Result<usize> {
        let tx = sql(self.conn.unchecked_transaction())?;
        self.validate_planner_trash()?;
        let ids: Vec<String> = {
            let mut stmt = sql(tx.prepare(
                "SELECT task_id FROM planner_trash WHERE deleted_at<=? ORDER BY task_id",
            ))?;
            let rows = sql(stmt.query_map([now.saturating_sub(30 * 24 * 60 * 60)], |r| r.get(0)))?;
            rows.collect::<rusqlite::Result<_>>()
                .map_err(|_| "Не удалось прочитать корзину")?
        };
        for id in &ids {
            let links: Vec<(String, String)> = {
                let mut stmt =
                    sql(tx.prepare("SELECT entry_id,fragment_id FROM task_links WHERE task_id=?"))?;
                let rows = sql(stmt.query_map([id], |r| Ok((r.get(0)?, r.get(1)?))))?;
                rows.collect::<rusqlite::Result<_>>()
                    .map_err(|_| "Не удалось прочитать связи")?
            };
            for (entry_id, fragment) in links {
                let entry = self.get(&entry_id)?;
                let doc = crate::task_links::without_fragment(&entry.document, &fragment);
                if doc != entry.document {
                    // Removing a service mark leaves text/FTS, formatting and trash status intact.
                    sql(tx.execute(
                        "UPDATE entries SET document=?,revision=revision+1,updated_at=? WHERE id=?",
                        params![
                            serde_json::to_string(&doc).map_err(|_| "Неверный документ")?,
                            chrono::Utc::now().to_rfc3339(),
                            entry_id
                        ],
                    ))?;
                }
            }
            sql(tx.execute("DELETE FROM task_links WHERE task_id=?", [id]))?;
            sql(tx.execute("DELETE FROM planner_task_events WHERE task_id=?", [id]))?;
            sql(tx.execute("DELETE FROM planner_task_assignees WHERE task_id=?", [id]))?;
            sql(tx.execute(
                "UPDATE planner_meta SET draft=NULL WHERE json_extract(draft,'$.id')=?",
                [id],
            ))?;
            sql(tx.execute("DELETE FROM planner_trash WHERE task_id=?", [id]))?;
            sql(tx.execute("DELETE FROM planner_tasks WHERE id=?", [id]))?;
        }
        if !ids.is_empty() {
            sql(tx.execute("UPDATE planner_meta SET revision=revision+1 WHERE id=1", []))?;
        }
        sql(tx.commit())?;
        Ok(ids.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::planner::{Change, Draft};
    use serde_json::json;
    fn draft() -> Draft {
        Draft {
            id: uuid::Uuid::new_v4().to_string(),
            title: "Task".into(),
            document: json!({"type":"doc","content":[{"type":"paragraph"}]}),
            deadline: None,
            assignee_id: None,
            revision: 0,
        }
    }
    fn flag(v: &mut Vault, id: &str, value: bool) {
        let revision = v
            .planner()
            .unwrap()
            .tasks
            .iter()
            .find(|t| t.id == id)
            .unwrap()
            .revision;
        v.planner_change(Change::Flag {
            id: id.into(),
            revision,
            field: "deleted".into(),
            value,
        })
        .unwrap();
    }
    #[test]
    fn expiry_boundary_restore_restart_backup_and_atomic_failure() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let (mut v, key) = Vault::create(&root, "trash test password").unwrap();
        let d = draft();
        v.planner_change(Change::Save { draft: d.clone() }).unwrap();
        flag(&mut v, &d.id, true);
        let start = chrono::Utc::now().timestamp() - 100;
        v.conn
            .execute("UPDATE planner_trash SET deleted_at=?", [start])
            .unwrap();
        assert_eq!(v.purge_planner_trash(start + 30 * 86400 - 1).unwrap(), 0);
        flag(&mut v, &d.id, false);
        assert_eq!(v.purge_planner_trash(start + 31 * 86400).unwrap(), 0);
        flag(&mut v, &d.id, true);
        let reset: i64 = v
            .conn
            .query_row("SELECT deleted_at FROM planner_trash", [], |r| r.get(0))
            .unwrap();
        assert!(reset > start);
        v.conn
            .execute("UPDATE planner_trash SET deleted_at=?", [start])
            .unwrap();
        let backup = dir.path().join("test.notbackup");
        v.backup(&backup).unwrap();
        let restored = Vault::restore(&backup, &dir.path().join("restored"), &key, true).unwrap();
        assert_eq!(restored.purge_planner_trash(start + 30 * 86400).unwrap(), 1);
        drop(v);
        let v = Vault::open(&root, &key, true).unwrap();
        v.conn.execute_batch("CREATE TRIGGER fail_purge BEFORE DELETE ON planner_tasks BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
        assert!(v.purge_planner_trash(start + 30 * 86400).is_err());
        v.validate_planner_trash().unwrap();
        v.validate_history().unwrap();
        assert_eq!(v.planner().unwrap().tasks.len(), 1);
        v.conn.execute_batch("DROP TRIGGER fail_purge").unwrap();
        assert_eq!(v.purge_planner_trash(start + 30 * 86400).unwrap(), 1);
        assert_eq!(v.purge_planner_trash(start + 30 * 86400).unwrap(), 0);
        v.validate_history().unwrap();
        v.validate_task_links().unwrap();
    }
    #[test]
    fn linked_task_purge_keeps_diary_text_and_formatting() {
        let dir = tempfile::tempdir().unwrap();
        let (mut v, _) = Vault::create(&dir.path().join("vault"), "trash test password").unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let fragment = uuid::Uuid::new_v4().to_string();
        let base = json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Keep diary text","marks":[{"type":"bold"}]}]}]});
        let saved = v
            .save(crate::vault::SaveEntry {
                id: id.clone(),
                date: "2026-11-14".into(),
                title: "Diary".into(),
                document: base.clone(),
                revision: 0,
            })
            .unwrap();
        let mut linked = base.clone();
        linked["content"][0]["content"][0]["marks"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"taskLink","attrs":{"fragmentId":fragment}}));
        let created = v
            .create_linked_task(
                crate::vault::SaveEntry {
                    id: id.clone(),
                    date: saved.date,
                    title: saved.title,
                    document: linked,
                    revision: saved.revision,
                },
                fragment,
                uuid::Uuid::new_v4().to_string(),
            )
            .unwrap();
        flag(&mut v, &created.task.id, true);
        assert_eq!(
            v.purge_planner_trash(chrono::Utc::now().timestamp() + 30 * 86400)
                .unwrap(),
            1
        );
        assert_eq!(v.get(&id).unwrap().document, base);
        assert!(!v.list("Keep", "all", "", 0).unwrap().is_empty());
        v.validate_task_links().unwrap();
        v.validate_history().unwrap();
    }
    #[test]
    fn v6_migration_starts_existing_trash_clock_without_changing_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let (mut v, key) = Vault::create(&root, "trash test password").unwrap();
        let d = draft();
        v.planner_change(Change::Save { draft: d.clone() }).unwrap();
        flag(&mut v, &d.id, true);
        v.conn.execute_batch("DROP TRIGGER planner_trash_insert; DROP TRIGGER planner_trash_delete; DROP TRIGGER planner_trash_restore; DROP TABLE planner_trash; PRAGMA user_version=6;").unwrap();
        drop(v);
        let start = chrono::Utc::now().timestamp();
        let v = Vault::open(&root, &key, true).unwrap();
        let date: i64 = v
            .conn
            .query_row("SELECT deleted_at FROM planner_trash", [], |r| r.get(0))
            .unwrap();
        assert!(date >= start);
        assert_eq!(v.purge_planner_trash(start).unwrap(), 0);
        assert!(std::fs::read_dir(dir.path().join("migration-backups"))
            .unwrap()
            .next()
            .is_some());
        drop(v);
        assert!(Vault::open(&root, "trash test password", false).is_ok());
    }
}
