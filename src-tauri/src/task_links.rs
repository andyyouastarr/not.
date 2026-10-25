//! Diary/task links live in the encrypted database. No document text is sent to
//! the native menu, written to preferences, or stored in an operation log.
use crate::{
    crypto::Result,
    planner::Task,
    vault::{valid_id, Entry, SaveEntry, Vault},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn sql<T>(r: rusqlite::Result<T>) -> Result<T> {
    r.map_err(|_| "Не удалось сохранить связь с задачей".into())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub fragment_id: String,
    pub entry_id: String,
    pub task_id: String,
    pub active: bool,
}
#[derive(Serialize)]
pub struct Created {
    pub entry: Entry,
    pub task: Task,
}
pub fn schema(conn: &Connection) -> Result<()> {
    let tx = sql(conn.unchecked_transaction())?;
    schema_in_transaction(&tx)?;
    sql(tx.commit())
}
pub(crate) fn schema_in_transaction(tx: &Connection) -> Result<()> {
    sql(tx.execute_batch(
        "CREATE TABLE task_links(
        fragment_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(id),
        task_id TEXT NOT NULL UNIQUE REFERENCES planner_tasks(id),
        operation_id TEXT NOT NULL UNIQUE, active INTEGER NOT NULL,
        cancelled INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX task_links_entry ON task_links(entry_id);
        PRAGMA user_version=3;",
    ))?;
    Ok(())
}
pub fn fragments(doc: &Value) -> Result<BTreeSet<String>> {
    fn walk(v: &Value, ids: &mut BTreeSet<String>) -> Result<()> {
        let mut count = 0;
        if let Some(marks) = v["marks"].as_array() {
            for mark in marks.iter().filter(|m| m["type"] == "taskLink") {
                count += 1;
                let id = mark["attrs"]["fragmentId"]
                    .as_str()
                    .ok_or("Неверная связь")?;
                valid_id(id)?;
                if v["type"] != "text" || v["text"].as_str().is_none_or(str::is_empty) || count > 1
                {
                    return Err("Неверная связанная область".into());
                }
                ids.insert(id.to_string());
            }
        }
        if let Some(children) = v["content"].as_array() {
            for child in children {
                walk(child, ids)?;
            }
        }
        Ok(())
    }
    let mut ids = BTreeSet::new();
    walk(doc, &mut ids)?;
    Ok(ids)
}
pub fn without_fragment(doc: &Value, id: &str) -> Value {
    let mut result = doc.clone();
    if let Some(marks) = result.get_mut("marks").and_then(Value::as_array_mut) {
        marks.retain(|m| m["type"] != "taskLink" || m["attrs"]["fragmentId"] != id);
        if marks.is_empty() {
            result.as_object_mut().unwrap().remove("marks");
        }
    }
    if let Some(children) = result.get_mut("content").and_then(Value::as_array_mut) {
        for child in children.iter_mut() {
            *child = without_fragment(child, id);
        }
        // ProseMirror merges adjacent identically marked text after removing a mark.
        let mut merged: Vec<Value> = Vec::new();
        for child in std::mem::take(children) {
            if let Some(last) = merged.last_mut() {
                if last["type"] == "text"
                    && child["type"] == "text"
                    && last["marks"] == child["marks"]
                {
                    last["text"] = json!(format!(
                        "{}{}",
                        last["text"].as_str().unwrap_or(""),
                        child["text"].as_str().unwrap_or("")
                    ));
                    continue;
                }
            }
            merged.push(child);
        }
        *children = merged;
    }
    result
}
pub fn title(doc: &Value, fragment: &str) -> Result<String> {
    fn walk(v: &Value, id: &str, out: &mut String) {
        if v["marks"].as_array().is_some_and(|ms| {
            ms.iter()
                .any(|m| m["type"] == "taskLink" && m["attrs"]["fragmentId"] == id)
        }) {
            out.push_str(v["text"].as_str().unwrap_or(""));
        }
        if v["type"] == "hardBreak" {
            out.push(' ');
        }
        if let Some(children) = v["content"].as_array() {
            for child in children {
                walk(child, id, out);
            }
            out.push(' ');
        }
    }
    let mut text = String::new();
    walk(doc, fragment, &mut text);
    // ECMAScript and Rust whitespace differ for BOM/NEL; use one explicit set.
    let title = text
        .split(is_space)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if title.chars().count() > 300 {
        return Err("Название слишком длинное".into());
    }
    if title.is_empty() {
        return Err("Выделите текст для названия задачи".into());
    }
    Ok(title)
}
fn is_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{0085}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
pub fn sync(conn: &Connection, entry: &str, document: &Value) -> Result<()> {
    let ids = fragments(document)?;
    for id in &ids {
        let owner: Option<String> = sql(conn
            .query_row(
                "SELECT entry_id FROM task_links WHERE fragment_id=? AND cancelled=0",
                [id],
                |r| r.get(0),
            )
            .optional())?;
        if owner.as_deref() != Some(entry) {
            return Err("Связь не принадлежит этой записи".into());
        }
    }
    sql(conn.execute("UPDATE task_links SET active=0 WHERE entry_id=?", [entry]))?;
    for id in ids {
        sql(conn.execute("UPDATE task_links SET active=1 WHERE fragment_id=?", [id]))?;
    }
    Ok(())
}
impl Vault {
    pub fn task_links(&self) -> Result<Vec<Link>> {
        let mut stmt = sql(self.conn.prepare(
            "SELECT fragment_id,entry_id,task_id,active FROM task_links WHERE cancelled=0",
        ))?;
        let rows = sql(stmt.query_map([], |r| {
            Ok(Link {
                fragment_id: r.get(0)?,
                entry_id: r.get(1)?,
                task_id: r.get(2)?,
                active: r.get(3)?,
            })
        }))?;
        rows.map(sql).collect()
    }
    pub fn create_linked_task(
        &self,
        entry: SaveEntry,
        fragment: String,
        operation: String,
    ) -> Result<Created> {
        valid_id(&fragment)?;
        valid_id(&operation)?;
        let tx = sql(self.conn.unchecked_transaction())?;
        let replay: Option<(String,String,String,bool)> = sql(tx.query_row("SELECT entry_id,fragment_id,task_id,cancelled FROM task_links WHERE operation_id=?", [&operation], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional())?;
        if let Some((owner, id, task, cancelled)) = replay {
            if owner != entry.id || id != fragment || cancelled {
                return Err("Операция уже завершена".into());
            }
            return Ok(Created {
                entry: self.get(&owner)?,
                task: self
                    .planner()?
                    .tasks
                    .into_iter()
                    .find(|t| t.id == task)
                    .ok_or("Задача недоступна")?,
            });
        }
        let old = self.get(&entry.id)?;
        if old.revision != entry.revision || old.deleted {
            return Err("Запись изменилась. Повторите действие.".into());
        }
        let old_ids = fragments(&old.document)?;
        let mut expected = old_ids.clone();
        expected.insert(fragment.clone());
        if old_ids.contains(&fragment)
            || fragments(&entry.document)? != expected
            || without_fragment(&entry.document, &fragment) != old.document
            || old.title != entry.title
            || old.date != entry.date
        {
            return Err("Выделение изменилось. Повторите действие.".into());
        }
        let title = title(&entry.document, &fragment)?;
        let board = self.planner()?;
        let task = Task {
            id: uuid::Uuid::new_v4().to_string(),
            title,
            document: json!({"type":"doc","content":[{"type":"paragraph"}]}),
            deadline: None,
            assignee_id: None,
            stage_id: None,
            position: board
                .tasks
                .iter()
                .filter(|t| t.stage_id.is_none() && !t.deleted && !t.archived)
                .map(|t| t.position)
                .max()
                .unwrap_or(-1)
                + 1,
            archived: false,
            deleted: false,
            revision: 1,
            updated_at: chrono::Utc::now().to_rfc3339(),
        };
        sql(tx.execute(
            "INSERT INTO planner_tasks VALUES(?,?)",
            params![task.id, crate::assignees::stored_task(&task)],
        ))?;
        sql(tx.execute(
            "INSERT INTO task_links VALUES(?,?,?,?,1,0)",
            params![fragment, entry.id, task.id, operation],
        ))?;
        sql(tx.execute("UPDATE planner_meta SET revision=revision+1 WHERE id=1", []))?;
        let saved = self.save_in_transaction(entry)?;
        sql(tx.commit())?;
        Ok(Created { entry: saved, task })
    }
    pub fn undo_linked_task(
        &self,
        entry: SaveEntry,
        fragment: String,
        revision: i64,
    ) -> Result<Entry> {
        let tx = sql(self.conn.unchecked_transaction())?;
        let link = self
            .task_links()?
            .into_iter()
            .find(|l| l.fragment_id == fragment && l.entry_id == entry.id && l.active)
            .ok_or("Связь уже изменилась")?;
        let mut task = self
            .planner()?
            .tasks
            .into_iter()
            .find(|t| t.id == link.task_id)
            .ok_or("Задача недоступна")?;
        if task.revision != revision || task.deleted || task.archived {
            return Err("Задача уже изменилась. Отмена недоступна.".into());
        }
        let old = self.get(&entry.id)?;
        if without_fragment(&old.document, &fragment) != entry.document
            || old.title != entry.title
            || old.date != entry.date
        {
            return Err("Фрагмент изменился. Отмена недоступна.".into());
        }
        task.deleted = true;
        task.revision += 1;
        task.updated_at = chrono::Utc::now().to_rfc3339();
        sql(tx.execute(
            "UPDATE planner_tasks SET payload=? WHERE id=?",
            params![crate::assignees::stored_task(&task), task.id],
        ))?;
        let saved = self.save_in_transaction(entry)?;
        sql(tx.execute(
            "UPDATE task_links SET cancelled=1 WHERE fragment_id=?",
            [&fragment],
        ))?;
        sql(tx.execute("UPDATE planner_meta SET revision=revision+1 WHERE id=1", []))?;
        sql(tx.commit())?;
        Ok(saved)
    }
    pub fn validate_task_links(&self) -> Result<()> {
        let board = self.planner()?;
        let links = self.task_links()?;
        for link in &links {
            valid_id(&link.fragment_id)?;
            let entry = self.get(&link.entry_id)?;
            if !board.tasks.iter().any(|t| t.id == link.task_id)
                || fragments(&entry.document)?.contains(&link.fragment_id) != link.active
            {
                return Err("Повреждены связи задач".into());
            }
        }
        let mut stmt = sql(self.conn.prepare("SELECT id,document FROM entries"))?;
        let rows =
            sql(stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))))?;
        for row in rows {
            let (id, doc) = sql(row)?;
            let doc: Value = serde_json::from_str(&doc).map_err(|_| "Повреждён документ")?;
            for fragment in fragments(&doc)? {
                if !links
                    .iter()
                    .any(|l| l.fragment_id == fragment && l.entry_id == id && l.active)
                {
                    return Err("Неизвестная связь в документе".into());
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(text: &str) -> SaveEntry {
        SaveEntry {
            id: uuid::Uuid::new_v4().to_string(),
            date: "2026-10-04".into(),
            title: "Journal".into(),
            revision: 0,
            document: json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]}),
        }
    }
    fn marked(v: &mut Vault, text: &str) -> (SaveEntry, String) {
        let mut e = input(text);
        let saved = v.save(e.clone()).unwrap();
        e.revision = saved.revision;
        let id = uuid::Uuid::new_v4().to_string();
        e.document["content"][0]["content"][0]["marks"] =
            json!([{"type":"taskLink","attrs":{"fragmentId":id}}]);
        (e, id)
    }
    #[test]
    fn create_is_atomic_idempotent_and_preserves_other_draft() {
        let dir = tempfile::tempdir().unwrap();
        let (mut v, _) = Vault::create(&dir.path().join("vault"), "link test password").unwrap();
        let draft = crate::planner::Draft {
            id: uuid::Uuid::new_v4().to_string(),
            title: "other".into(),
            document: json!({"type":"doc","content":[{"type":"paragraph"}]}),
            deadline: None,
            assignee_id: None,
            revision: 0,
        };
        v.planner_change(crate::planner::Change::Draft {
            draft: Some(draft.clone()),
        })
        .unwrap();
        let (e, id) = marked(&mut v, "Русский\n  текст 🎈");
        let op = uuid::Uuid::new_v4().to_string();
        let created = v
            .create_linked_task(e.clone(), id.clone(), op.clone())
            .unwrap();
        assert_eq!(created.task.title, "Русский текст 🎈");
        assert_eq!(
            v.create_linked_task(e, id, op).unwrap().task.id,
            created.task.id
        );
        assert_eq!(v.planner().unwrap().tasks.len(), 1);
        assert_eq!(v.planner().unwrap().draft.unwrap().id, draft.id);
        v.validate_task_links().unwrap();
        let (e, id) = marked(&mut v, "atomic failure");
        v.conn.execute_batch("CREATE TRIGGER fail_entry BEFORE UPDATE ON entries BEGIN SELECT RAISE(FAIL,'injected'); END;").unwrap();
        assert!(v
            .create_linked_task(e, id, uuid::Uuid::new_v4().to_string())
            .is_err());
        assert_eq!(v.planner().unwrap().tasks.len(), 1);
        assert_eq!(v.task_links().unwrap().len(), 1);
    }
    #[test]
    fn unicode_limits_and_foreign_links() {
        let dir = tempfile::tempdir().unwrap();
        let (mut v, _) = Vault::create(&dir.path().join("vault"), "link test password").unwrap();
        for count in [299, 300, 301] {
            let (e, id) = marked(&mut v, &"🎈".repeat(count));
            let result = v.create_linked_task(e, id, uuid::Uuid::new_v4().to_string());
            if count == 301 {
                assert_eq!(result.err().unwrap(), "Название слишком длинное");
            } else {
                assert_eq!(result.unwrap().task.title.chars().count(), count);
            }
        }
        let (e, _) = marked(&mut v, "forged");
        assert!(v.save(e).is_err());
        assert_eq!(v.planner().unwrap().tasks.len(), 2);
    }
    #[test]
    fn unlink_restore_undo_conflict_and_backup() {
        let dir = tempfile::tempdir().unwrap();
        let (mut v, key) = Vault::create(&dir.path().join("vault"), "link test password").unwrap();
        let (mut e, id) = marked(&mut v, "LinkedSecretMarker");
        let created = v
            .create_linked_task(e.clone(), id.clone(), uuid::Uuid::new_v4().to_string())
            .unwrap();
        e.revision = created.entry.revision;
        let linked = e.document.clone();
        e.document = without_fragment(&e.document, &id);
        let unlinked = v.save(e.clone()).unwrap();
        assert!(!v.task_links().unwrap()[0].active);
        e.revision = unlinked.revision;
        e.document = linked;
        let restored = v.save(e.clone()).unwrap();
        assert!(v.task_links().unwrap()[0].active);
        e.revision = restored.revision;
        e.document = without_fragment(&e.document, &id);
        assert!(v.undo_linked_task(e.clone(), id.clone(), 99).is_err());
        assert!(!v.planner().unwrap().tasks[0].deleted);
        let backup = dir.path().join("links.notbackup");
        v.backup(&backup).unwrap();
        let copy = Vault::restore(&backup, &dir.path().join("restored"), &key, true).unwrap();
        copy.validate_task_links().unwrap();
        assert!(copy.task_links().unwrap()[0].active);
        let exported = dir.path().join("export");
        std::fs::create_dir(&exported).unwrap();
        crate::export::export(&v, &e.id, &exported).unwrap();
        for file in ["journal.db", "vault.json"] {
            assert!(!std::fs::read(v.root.join(file))
                .unwrap()
                .windows(18)
                .any(|s| s == b"LinkedSecretMarker"));
        }
        v.undo_linked_task(e, id, 1).unwrap();
        assert!(v.task_links().unwrap().is_empty());
        assert!(v.planner().unwrap().tasks[0].deleted);
    }
    #[test]
    fn v2_migration_preserves_password_and_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let (v, key) = Vault::create(&root, "link test password").unwrap();
        v.conn
            .execute_batch("DROP TABLE planner_task_events; DROP TABLE planner_task_assignees; DROP TABLE planner_assignees; DROP TABLE task_links; PRAGMA user_version=2;")
            .unwrap();
        drop(v);
        let v = Vault::open(&root, "link test password", false).unwrap();
        assert!(v.task_links().unwrap().is_empty());
        drop(v);
        assert!(Vault::open(&root, &key, true).is_ok());
        assert_eq!(
            std::fs::read_dir(dir.path().join("migration-backups"))
                .unwrap()
                .count(),
            1
        );
    }
}
