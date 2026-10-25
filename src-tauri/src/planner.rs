use crate::{
    crypto::Result,
    vault::{valid_id, validate_document, Vault},
};
use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

fn sql<T>(result: rusqlite::Result<T>) -> Result<T> {
    result.map_err(|_| "Не удалось сохранить Планер".into())
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stage {
    pub id: String,
    pub title: String,
    pub completed: bool,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub document: Value,
    pub deadline: Option<String>,
    #[serde(default)]
    pub assignee_id: Option<String>,
    pub stage_id: Option<String>,
    pub position: i64,
    pub archived: bool,
    pub deleted: bool,
    pub revision: i64,
    pub updated_at: String,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft {
    pub id: String,
    pub title: String,
    pub document: Value,
    pub deadline: Option<String>,
    #[serde(default)]
    pub assignee_id: Option<String>,
    pub revision: i64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub stages: Vec<Stage>,
    pub tasks: Vec<Task>,
    pub draft: Option<Draft>,
    pub revision: i64,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum Change {
    Save {
        draft: Draft,
    },
    Draft {
        draft: Option<Draft>,
    },
    Move {
        id: String,
        revision: i64,
        stage: Option<String>,
        before: Option<String>,
    },
    Flag {
        id: String,
        revision: i64,
        field: String,
        value: bool,
    },
    Stages {
        stages: Vec<Stage>,
        revision: i64,
        removed: Option<String>,
        destination: Option<String>,
    },
}
pub fn schema(conn: &Connection) -> Result<()> {
    let tx = sql(conn.unchecked_transaction())?;
    schema_in_transaction(&tx)?;
    sql(tx.commit())
}
pub(crate) fn schema_in_transaction(tx: &Connection) -> Result<()> {
    sql(tx.execute_batch("CREATE TABLE planner_stages(id TEXT PRIMARY KEY,position INTEGER NOT NULL,payload TEXT NOT NULL);
CREATE TABLE planner_tasks(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE planner_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,draft TEXT);
INSERT INTO planner_meta VALUES(1,0,NULL);"))?;
    for (i, title) in ["К выполнению", "В работе", "Готово"].iter().enumerate()
    {
        let stage = Stage {
            id: Uuid::new_v4().to_string(),
            title: title.to_string(),
            completed: i == 2,
        };
        sql(tx.execute(
            "INSERT INTO planner_stages VALUES(?,?,?)",
            params![stage.id, i, serde_json::to_string(&stage).unwrap()],
        ))?;
    }
    sql(tx.execute_batch("PRAGMA user_version=2;"))?;
    Ok(())
}
fn decode<T: serde::de::DeserializeOwned>(s: String) -> Result<T> {
    serde_json::from_str(&s).map_err(|_| "Повреждены данные Планера".into())
}
fn rows<T: serde::de::DeserializeOwned>(conn: &Connection, query: &str) -> Result<Vec<T>> {
    let mut statement = sql(conn.prepare(query))?;
    let raw = sql(statement.query_map([], |r| r.get::<_, String>(0)))?;
    raw.map(|r| decode(sql(r)?)).collect()
}
fn document(vault: &Vault, draft: &Draft, require_title: bool) -> Result<()> {
    if !crate::task_links::fragments(&draft.document)?.is_empty() {
        return Err("Связи разрешены только в дневнике".into());
    }
    valid_id(&draft.id)?;
    crate::assignees::validate_choice(&vault.conn, &draft.assignee_id, &None, true)?;
    if draft.title.chars().count() > 300
        || (require_title && draft.title.trim().is_empty())
        || draft.revision < 0
    {
        return Err("Введите название задачи (до 300 символов)".into());
    }
    if let Some(date) = &draft.deadline {
        let parsed =
            chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| "Неверный дедлайн")?;
        if parsed.format("%Y-%m-%d").to_string() != *date {
            return Err("Неверный дедлайн".into());
        }
    }
    for id in validate_document(&draft.document)? {
        vault.attachment(&id)?;
    }
    Ok(())
}
fn stage_exists(stages: &[Stage], id: &Option<String>) -> Result<()> {
    if id
        .as_ref()
        .is_some_and(|id| !stages.iter().any(|s| &s.id == id))
    {
        return Err("Стадия больше не существует".into());
    }
    Ok(())
}
fn task_mut<'a>(tasks: &'a mut [Task], id: &str, revision: i64) -> Result<&'a mut Task> {
    let task = tasks
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or("Задача не найдена")?;
    if task.revision != revision {
        return Err("Задача изменилась. Откройте её заново.".into());
    }
    Ok(task)
}
fn touch(task: &mut Task) {
    task.revision += 1;
    task.updated_at = Utc::now().to_rfc3339();
}

impl Vault {
    pub fn planner(&self) -> Result<Board> {
        let stages = rows(
            &self.conn,
            "SELECT payload FROM planner_stages ORDER BY position",
        )?;
        let tasks = rows(&self.conn, "SELECT json_set(t.payload,'$.assigneeId',a.assignee_id) FROM planner_tasks t LEFT JOIN planner_task_assignees a ON a.task_id=t.id ORDER BY t.id")?;
        let (revision, draft): (i64, Option<String>) = sql(self.conn.query_row(
            "SELECT revision,draft FROM planner_meta WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?;
        Ok(Board {
            stages,
            tasks,
            revision,
            draft: draft.map(decode).transpose()?,
        })
    }
    pub fn validate_planner(&self) -> Result<()> {
        let board = self.planner()?;
        for table in ["planner_tasks", "planner_stages"] {
            let invalid: i64 = sql(self.conn.query_row(&format!("SELECT count(*) FROM {table} WHERE id != json_extract(payload,'$.id') OR json_extract(payload,'$.id') IS NULL"), [], |r| r.get(0)))?;
            if invalid != 0 {
                return Err("Повреждены идентификаторы Планера".into());
            }
        }
        let positions: i64 = sql(self.conn.query_row(
            "SELECT count(*) FROM planner_stages WHERE position < 0",
            [],
            |r| r.get(0),
        ))?;
        if positions != 0 || board.revision < 0 {
            return Err("Повреждён порядок стадий".into());
        }
        for stage in &board.stages {
            valid_id(&stage.id)?;
            if stage.title.trim().is_empty() || stage.title.chars().count() > 100 {
                return Err("Неверная стадия".into());
            }
        }
        for task in &board.tasks {
            stage_exists(&board.stages, &task.stage_id)?;
            document(
                self,
                &Draft {
                    id: task.id.clone(),
                    title: task.title.clone(),
                    document: task.document.clone(),
                    deadline: task.deadline.clone(),
                    assignee_id: task.assignee_id.clone(),
                    revision: task.revision,
                },
                true,
            )?;
            if task.position < 0 || task.revision < 1 {
                return Err("Повреждён порядок задач".into());
            }
        }
        if let Some(draft) = &board.draft {
            document(self, draft, false)?;
        }
        Ok(())
    }
    pub fn planner_change(&mut self, change: Change) -> Result<Board> {
        // Read revisions and mutate within one SQLite snapshot. A concurrent
        // process cannot overwrite a revision read before it committed a change.
        let tx = sql(self.conn.unchecked_transaction())?;
        let mut board = self.planner()?;
        let original = board.clone();
        let previous_tasks: std::collections::HashMap<_, _> = board
            .tasks
            .iter()
            .map(|t| (t.id.clone(), t.revision))
            .collect();
        let stages_changed = matches!(&change, Change::Stages { .. });
        if let Change::Draft { draft } = &change {
            if let Some(draft) = draft {
                document(self, draft, false)?;
            }
            let raw = draft.as_ref().map(|d| serde_json::to_string(d).unwrap());
            sql(self
                .conn
                .execute("UPDATE planner_meta SET draft=? WHERE id=1", [raw]))?;
            board.draft = draft.clone();
            sql(tx.commit())?;
            return Ok(board);
        }
        match change {
            Change::Save { draft } => {
                document(self, &draft, true)?;
                let previous = board
                    .tasks
                    .iter()
                    .find(|t| t.id == draft.id)
                    .and_then(|t| t.assignee_id.clone());
                crate::assignees::validate_choice(
                    &self.conn,
                    &draft.assignee_id,
                    &previous,
                    false,
                )?;
                if board.tasks.iter().any(|t| t.id == draft.id) {
                    let t = task_mut(&mut board.tasks, &draft.id, draft.revision)?;
                    if t.deleted || t.archived {
                        return Err("Сначала восстановите задачу".into());
                    }
                    t.title = draft.title.trim().into();
                    t.document = draft.document;
                    t.deadline = draft.deadline;
                    t.assignee_id = draft.assignee_id;
                    touch(t);
                } else {
                    if draft.revision != 0 {
                        return Err("Задача не найдена".into());
                    }
                    let position = board.tasks.iter().map(|t| t.position).max().unwrap_or(-1) + 1;
                    board.tasks.push(Task {
                        id: draft.id,
                        title: draft.title.trim().into(),
                        document: draft.document,
                        deadline: draft.deadline,
                        assignee_id: draft.assignee_id,
                        stage_id: None,
                        position,
                        archived: false,
                        deleted: false,
                        revision: 1,
                        updated_at: Utc::now().to_rfc3339(),
                    });
                }
                board.draft = None;
            }
            Change::Move {
                id,
                revision,
                stage,
                before,
            } => {
                stage_exists(&board.stages, &stage)?;
                let t = task_mut(&mut board.tasks, &id, revision)?;
                if t.deleted || t.archived {
                    return Err("Сначала восстановите задачу".into());
                }
                t.stage_id = stage.clone();
                touch(t);
                let mut order: Vec<_> = board
                    .tasks
                    .iter()
                    .filter(|t| t.id != id && t.stage_id == stage && !t.deleted && !t.archived)
                    .map(|t| (t.position, t.id.clone()))
                    .collect();
                order.sort();
                let index = if let Some(before) = before {
                    order
                        .iter()
                        .position(|(_, v)| v == &before)
                        .ok_or("Позиция изменилась")?
                } else {
                    order.len()
                };
                order.insert(index, (0, id));
                for (position, (_, id)) in order.iter().enumerate() {
                    let t = board.tasks.iter_mut().find(|t| &t.id == id).unwrap();
                    if t.position != position as i64 {
                        t.position = position as i64;
                        touch(t);
                    }
                }
            }
            Change::Flag {
                id,
                revision,
                field,
                value,
            } => {
                let t = task_mut(&mut board.tasks, &id, revision)?;
                match field.as_str() {
                    "archived" => {
                        if t.deleted
                            || (value
                                && !board
                                    .stages
                                    .iter()
                                    .any(|s| Some(&s.id) == t.stage_id.as_ref() && s.completed))
                        {
                            return Err("Архивировать можно только завершённую задачу".into());
                        }
                        t.archived = value;
                    }
                    "deleted" => t.deleted = value,
                    _ => return Err("Неверная операция".into()),
                }
                touch(t);
            }
            Change::Stages {
                stages,
                revision,
                removed,
                destination,
            } => {
                if revision != board.revision {
                    return Err("Стадии изменились. Откройте настройки заново.".into());
                }
                let mut ids = std::collections::HashSet::new();
                for s in &stages {
                    valid_id(&s.id)?;
                    if s.title.trim().is_empty()
                        || s.title.chars().count() > 100
                        || !ids.insert(&s.id)
                    {
                        return Err("Проверьте названия стадий".into());
                    }
                }
                let missing: Vec<_> = board
                    .stages
                    .iter()
                    .filter(|s| !ids.contains(&s.id))
                    .collect();
                if missing.len() > 1
                    || missing
                        .first()
                        .is_some_and(|s| Some(&s.id) != removed.as_ref())
                {
                    return Err("Удаляйте стадии по одной".into());
                }
                stage_exists(&stages, &destination)?;
                if let Some(id) = removed {
                    for t in &mut board.tasks {
                        if t.stage_id.as_ref() == Some(&id) {
                            t.stage_id = destination.clone();
                            touch(t);
                        }
                    }
                }
                board.stages = stages;
            }
            Change::Draft { .. } => unreachable!(),
        }
        if stages_changed {
            for task in &mut board.tasks {
                let old = original.tasks.iter().find(|t| t.id == task.id).unwrap();
                let was_completed = original
                    .stages
                    .iter()
                    .any(|s| Some(&s.id) == old.stage_id.as_ref() && s.completed);
                let is_completed = board
                    .stages
                    .iter()
                    .any(|s| Some(&s.id) == task.stage_id.as_ref() && s.completed);
                if was_completed != is_completed && task.revision == old.revision {
                    touch(task);
                }
            }
            sql(tx.execute("DELETE FROM planner_stages", []))?;
            for (i, s) in board.stages.iter().enumerate() {
                sql(tx.execute(
                    "INSERT INTO planner_stages VALUES(?,?,?)",
                    params![s.id, i, serde_json::to_string(s).unwrap()],
                ))?;
            }
        }
        for t in board
            .tasks
            .iter()
            .filter(|t| previous_tasks.get(&t.id) != Some(&t.revision))
        {
            sql(tx.execute("INSERT INTO planner_tasks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", params![t.id, crate::assignees::stored_task(t)]))?;
        }
        crate::assignees::record_changes(&tx, &original, &board, stages_changed)?;
        board.revision += 1;
        sql(tx.execute(
            "UPDATE planner_meta SET revision=?,draft=? WHERE id=1",
            params![
                board.revision,
                board
                    .draft
                    .as_ref()
                    .map(|d| serde_json::to_string(d).unwrap())
            ],
        ))?;
        sql(tx.commit())?;
        Ok(board)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn draft(title: &str) -> Draft {
        Draft {
            id: Uuid::new_v4().to_string(),
            title: title.into(),
            document: json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"PlannerSecretMarker 🔒"}]}]}),
            deadline: Some("2026-12-31".into()),
            assignee_id: None,
            revision: 0,
        }
    }
    #[test]
    fn task_lifecycle_revisions_order_and_deleted_stage() {
        let dir = tempfile::tempdir().unwrap();
        let (mut v, _) = Vault::create(&dir.path().join("vault"), "planner test password").unwrap();
        let a = draft("Первая");
        let b = draft("Вторая");
        v.planner_change(Change::Save { draft: a.clone() }).unwrap();
        let board = v.planner_change(Change::Save { draft: b.clone() }).unwrap();
        let done = board.stages[2].id.clone();
        assert!(v.planner_change(Change::Save { draft: a.clone() }).is_err());
        let moved = v
            .planner_change(Change::Move {
                id: b.id.clone(),
                revision: 1,
                stage: None,
                before: Some(a.id.clone()),
            })
            .unwrap();
        assert_eq!(
            moved.tasks.iter().find(|t| t.id == b.id).unwrap().position,
            0
        );
        let rev = moved.tasks.iter().find(|t| t.id == a.id).unwrap().revision;
        assert!(v
            .planner_change(Change::Flag {
                id: a.id.clone(),
                revision: rev,
                field: "archived".into(),
                value: true
            })
            .is_err());
        let board = v
            .planner_change(Change::Move {
                id: a.id.clone(),
                revision: rev,
                stage: Some(done.clone()),
                before: None,
            })
            .unwrap();
        let rev = board.tasks.iter().find(|t| t.id == a.id).unwrap().revision;
        let board = v
            .planner_change(Change::Flag {
                id: a.id.clone(),
                revision: rev,
                field: "archived".into(),
                value: true,
            })
            .unwrap();
        let rev = board.tasks.iter().find(|t| t.id == a.id).unwrap().revision;
        let board = v
            .planner_change(Change::Flag {
                id: a.id.clone(),
                revision: rev,
                field: "deleted".into(),
                value: true,
            })
            .unwrap();
        let board = v
            .planner_change(Change::Stages {
                stages: board.stages[..2].to_vec(),
                revision: board.revision,
                removed: Some(done),
                destination: None,
            })
            .unwrap();
        let task = board.tasks.iter().find(|t| t.id == a.id).unwrap();
        assert!(task.archived && task.deleted && task.stage_id.is_none());
        assert!(v
            .planner_change(Change::Move {
                id: b.id,
                revision: 999,
                stage: None,
                before: None
            })
            .is_err());
        v.validate_planner().unwrap();
    }
    #[test]
    fn encrypted_draft_backup_and_write_failure() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let (mut v, key) = Vault::create(&root, "planner test password").unwrap();
        let d = draft("Секретная задача");
        v.planner_change(Change::Draft {
            draft: Some(d.clone()),
        })
        .unwrap();
        assert!(v.planner().unwrap().tasks.is_empty());
        v.conn.execute_batch("PRAGMA query_only=ON").unwrap();
        assert!(v.planner_change(Change::Save { draft: d.clone() }).is_err());
        assert!(v.planner().unwrap().draft.is_some());
        assert!(v.planner().unwrap().tasks.is_empty());
        v.conn.execute_batch("PRAGMA query_only=OFF").unwrap();
        v.planner_change(Change::Save { draft: d }).unwrap();
        let pending = draft("Черновик после перезапуска");
        v.planner_change(Change::Draft {
            draft: Some(pending.clone()),
        })
        .unwrap();
        let backup = dir.path().join("planner.notbackup");
        v.backup(&backup).unwrap();
        drop(v);
        let reopened = Vault::open(&root, &key, true).unwrap();
        assert_eq!(reopened.planner().unwrap().draft.unwrap().id, pending.id);
        let restored = Vault::restore(&backup, &dir.path().join("restored"), &key, true).unwrap();
        assert_eq!(restored.planner().unwrap().tasks.len(), 1);
        assert_eq!(
            restored.planner().unwrap().draft.unwrap().title,
            pending.title
        );
        for file in [root.join("journal.db"), backup] {
            let bytes = std::fs::read(file).unwrap();
            assert!(!bytes
                .windows(b"PlannerSecretMarker".len())
                .any(|s| s == b"PlannerSecretMarker"));
        }
    }
    #[test]
    fn v1_migration_keeps_verified_original_and_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let (v, key) = Vault::create(&root, "planner test password").unwrap();
        v.conn.execute_batch("DROP TABLE planner_task_events; DROP TABLE planner_task_assignees; DROP TABLE planner_assignees; DROP TABLE task_links; DROP TABLE planner_tasks; DROP TABLE planner_stages; DROP TABLE planner_meta; PRAGMA user_version=1;").unwrap();
        let old = dir.path().join("old.notbackup");
        v.backup(&old).unwrap();
        drop(v);
        let upgraded = Vault::open(&root, "planner test password", false).unwrap();
        assert_eq!(upgraded.planner().unwrap().stages.len(), 3);
        assert_eq!(
            upgraded
                .conn
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            4
        );
        assert!(std::fs::read_dir(dir.path().join("migration-backups"))
            .unwrap()
            .next()
            .is_some());
        drop(upgraded);
        assert!(Vault::open(&root, &key, true).is_ok());
        let restored = Vault::restore(&old, &dir.path().join("old-restored"), &key, true).unwrap();
        assert_eq!(restored.planner().unwrap().stages.len(), 3);
    }
    #[test]
    fn migration_failure_rolls_back_schema_and_preserves_entries() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let (v, _) = Vault::create(&root, "planner test password").unwrap();
        v.conn
            .execute_batch(
                "DROP TABLE planner_tasks; DROP TABLE planner_stages; PRAGMA user_version=1;",
            )
            .unwrap();
        // Existing meta table injects a failure halfway through migration.
        assert!(schema(&v.conn).is_err());
        assert_eq!(
            v.conn
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        let tables: i64 = v
            .conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='planner_stages'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 0);
        assert!(v.list("", "all", "", 0).unwrap().is_empty());
    }
    #[test]
    fn task_attachments_restore_and_invalid_reference_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let (mut v, key) =
            Vault::create(&dir.path().join("vault"), "planner test password").unwrap();
        let file = dir.path().join("file.txt");
        std::fs::write(&file, b"Private task attachment").unwrap();
        let attachment = v.add_attachment(&file).unwrap();
        let mut d = draft("Вложение");
        d.document["content"].as_array_mut().unwrap().push(json!({"type":"attachment","attrs":{"attachmentId":attachment.id,"name":attachment.name,"mime":attachment.mime,"size":attachment.size}}));
        v.planner_change(Change::Save { draft: d.clone() }).unwrap();
        let archive = dir.path().join("attachment.notbackup");
        v.backup(&archive).unwrap();
        let restored = Vault::restore(&archive, &dir.path().join("restored"), &key, true).unwrap();
        assert_eq!(
            restored.read_attachment(&attachment.id).unwrap(),
            b"Private task attachment"
        );
        d.id = Uuid::new_v4().to_string();
        d.document["content"][1]["attrs"]["attachmentId"] = json!(Uuid::new_v4().to_string());
        assert!(v.planner_change(Change::Save { draft: d }).is_err());
        v.conn
            .execute(
                "UPDATE planner_tasks SET payload=json_set(payload,'$.stageId',?)",
                [Uuid::new_v4().to_string()],
            )
            .unwrap();
        let corrupt = dir.path().join("bad.notbackup");
        v.backup(&corrupt).unwrap();
        assert!(Vault::restore(&corrupt, &dir.path().join("bad-restored"), &key, true).is_err());
    }
}
