use crate::{
    crypto::Result,
    planner::{Board, Task},
    vault::{valid_id, Vault},
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;

fn sql<T>(r: rusqlite::Result<T>) -> Result<T> {
    r.map_err(|_| "Не удалось сохранить исполнителей".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::planner::{Change as TaskChange, Draft};
    use serde_json::json;
    use uuid::Uuid;
    fn create(v: &mut Vault, name: &str) -> String {
        let id = Uuid::new_v4().to_string();
        v.assignee_change(Change::Create {
            id: id.clone(),
            name: name.into(),
        })
        .unwrap();
        id
    }
    fn draft(assignee: Option<String>) -> Draft {
        Draft {
            id: Uuid::new_v4().to_string(),
            title: "AssigneeSecretMarker".into(),
            document: json!({"type":"doc","content":[{"type":"paragraph"}]}),
            deadline: None,
            assignee_id: assignee,
            revision: 0,
        }
    }
    fn count(v: &Vault) -> i64 {
        v.conn
            .query_row("SELECT count(*) FROM planner_task_events", [], |r| r.get(0))
            .unwrap()
    }
    #[test]
    fn names_unicode_idempotency_archive_and_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let (mut v, _) = Vault::create(&dir.path().join("v"), "test password").unwrap();
        let id = create(&mut v, "  Анна  Иванова  ");
        v.assignee_change(Change::Create {
            id: id.clone(),
            name: "АННА Иванова".into(),
        })
        .unwrap();
        assert_eq!(v.assignees().unwrap().len(), 1);
        assert!(v
            .assignee_change(Change::Create {
                id: Uuid::new_v4().to_string(),
                name: "анна\tИВАНОВА".into()
            })
            .is_err());
        assert_eq!(
            normalized("Straße").unwrap().1,
            normalized("STRASSE").unwrap().1
        );
        assert_eq!(normalized("e\u{301}").unwrap(), normalized("é").unwrap());
        assert!(normalized(&"🎈".repeat(100)).is_ok());
        assert!(normalized(&"🎈".repeat(101)).is_err());
        v.assignee_change(Change::Archive {
            id: id.clone(),
            revision: 1,
            archived: true,
        })
        .unwrap();
        assert!(v
            .assignee_change(Change::Rename {
                id: id.clone(),
                revision: 1,
                name: "другое".into()
            })
            .is_err());
        assert!(v
            .assignee_change(Change::Create {
                id: Uuid::new_v4().to_string(),
                name: "Анна Иванова".into()
            })
            .unwrap_err()
            .contains("архиве"));
        v.assignee_change(Change::Archive {
            id,
            revision: 2,
            archived: false,
        })
        .unwrap();
        v.validate_assignees().unwrap();
    }
    #[test]
    fn assignments_history_draft_and_atomic_failure() {
        let dir = tempfile::tempdir().unwrap();
        let (mut v, _) = Vault::create(&dir.path().join("v"), "test password").unwrap();
        let a = create(&mut v, "Анна");
        let b = create(&mut v, "Борис");
        let mut d = draft(Some(a.clone()));
        v.planner_change(TaskChange::Draft {
            draft: Some(d.clone()),
        })
        .unwrap();
        assert_eq!(count(&v), 0);
        v.planner_change(TaskChange::Save { draft: d.clone() })
            .unwrap();
        assert_eq!(count(&v), 1);
        let raw: String = v
            .conn
            .query_row("SELECT payload FROM planner_tasks", [], |r| r.get(0))
            .unwrap();
        assert!(!raw.contains("assigneeId"));
        d.revision = 1;
        v.planner_change(TaskChange::Save { draft: d.clone() })
            .unwrap();
        assert_eq!(count(&v), 1);
        v.assignee_change(Change::Archive {
            id: a.clone(),
            revision: 1,
            archived: true,
        })
        .unwrap();
        d.revision = 2;
        v.planner_change(TaskChange::Save { draft: d.clone() })
            .unwrap();
        assert!(v
            .planner_change(TaskChange::Save {
                draft: draft(Some(a.clone()))
            })
            .is_err());
        d.revision = 3;
        d.assignee_id = Some(b.clone());
        v.conn.execute_batch("CREATE TRIGGER fail_event BEFORE INSERT ON planner_task_events BEGIN SELECT RAISE(ABORT,'disk failure'); END;").unwrap();
        assert!(v
            .planner_change(TaskChange::Save { draft: d.clone() })
            .is_err());
        assert_eq!(v.planner().unwrap().tasks[0].assignee_id, Some(a));
        assert_eq!(count(&v), 1);
        v.conn.execute_batch("DROP TRIGGER fail_event").unwrap();
        v.planner_change(TaskChange::Save { draft: d.clone() })
            .unwrap();
        assert_eq!(count(&v), 2);
        let board = v.planner().unwrap();
        let stage = board.stages[2].id.clone();
        let board = v
            .planner_change(TaskChange::Move {
                id: d.id.clone(),
                revision: 4,
                stage: Some(stage.clone()),
                before: None,
            })
            .unwrap();
        assert_eq!(count(&v), 3);
        v.assignee_change(Change::Rename {
            id: b,
            revision: 1,
            name: "Новое имя".into(),
        })
        .unwrap();
        let snapshot: String = v
            .conn
            .query_row(
                "SELECT payload FROM planner_task_events WHERE kind='completed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(snapshot.contains("Борис"));
        d.revision = board.tasks[0].revision;
        d.assignee_id = None;
        let board = v.planner_change(TaskChange::Save { draft: d }).unwrap();
        assert_eq!(count(&v), 4);
        let mut stages = board.stages.clone();
        stages[2].completed = false;
        let board = v
            .planner_change(TaskChange::Stages {
                stages,
                revision: board.revision,
                removed: None,
                destination: None,
            })
            .unwrap();
        assert_eq!(count(&v), 5);
        let reason: String = v
            .conn
            .query_row(
                "SELECT reason FROM planner_task_events WHERE kind='reopened'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(reason, "stageSettings");
        v.planner_change(TaskChange::Flag {
            id: board.tasks[0].id.clone(),
            revision: board.tasks[0].revision,
            field: "deleted".into(),
            value: true,
        })
        .unwrap();
        assert_eq!(count(&v), 5);
    }
    #[test]
    fn v3_migration_backup_recovery_and_encrypted_history() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("v");
        let (mut v, key) = Vault::create(&root, "test password").unwrap();
        v.planner_change(TaskChange::Save { draft: draft(None) })
            .unwrap();
        v.conn.execute_batch("DROP TABLE planner_task_events; DROP TABLE planner_task_assignees; DROP TABLE planner_assignees; PRAGMA user_version=3;").unwrap();
        drop(v);
        let mut v = Vault::open(&root, &key, true).unwrap();
        assert_eq!(count(&v), 1);
        let id = create(&mut v, "SecretAssigneeMarker");
        let d = draft(Some(id.clone()));
        v.planner_change(TaskChange::Save { draft: d.clone() })
            .unwrap();
        let mut pending = draft(Some(id.clone()));
        pending.title = "Pending".into();
        v.planner_change(TaskChange::Draft {
            draft: Some(pending),
        })
        .unwrap();
        let path = dir.path().join("copy.notbackup");
        v.backup(&path).unwrap();
        let restored = Vault::restore(&path, &dir.path().join("restored"), &key, true).unwrap();
        restored.validate_assignees().unwrap();
        restored.validate_planner().unwrap();
        assert_eq!(
            restored
                .planner()
                .unwrap()
                .tasks
                .iter()
                .find(|t| t.id == d.id)
                .unwrap()
                .assignee_id,
            Some(id.clone())
        );
        assert_eq!(
            restored.planner().unwrap().draft.unwrap().assignee_id,
            Some(id)
        );
        assert_eq!(count(&restored), 2);
        for file in [root.join("journal.db"), path] {
            let bytes = std::fs::read(file).unwrap();
            for marker in [b"SecretAssigneeMarker".as_slice(), b"AssigneeSecretMarker"] {
                assert!(!bytes.windows(marker.len()).any(|w| w == marker));
            }
        }
        assert!(std::fs::read_dir(dir.path().join("migration-backups"))
            .unwrap()
            .next()
            .is_some());
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Assignee {
    pub id: String,
    pub name: String,
    pub archived: bool,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum Change {
    Create {
        id: String,
        name: String,
    },
    Rename {
        id: String,
        revision: i64,
        name: String,
    },
    Archive {
        id: String,
        revision: i64,
        archived: bool,
    },
}
pub fn normalized(input: &str) -> Result<(String, String)> {
    let name = input
        .nfc()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if name.is_empty() || name.chars().count() > 100 {
        return Err("Введите имя исполнителя (до 100 символов)".into());
    }
    let key = name.nfkc().case_fold().nfkc().collect();
    Ok((name, key))
}
pub fn schema(conn: &Connection) -> Result<()> {
    sql(conn.execute_batch("CREATE TABLE planner_assignees(id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, archived INTEGER NOT NULL CHECK(archived IN (0,1)), revision INTEGER NOT NULL CHECK(revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE planner_task_assignees(task_id TEXT PRIMARY KEY REFERENCES planner_tasks(id), assignee_id TEXT NOT NULL REFERENCES planner_assignees(id));
CREATE INDEX planner_assignee_tasks ON planner_task_assignees(assignee_id);
CREATE TABLE planner_task_events(id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES planner_tasks(id), revision INTEGER NOT NULL, occurred_at TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX planner_events_task ON planner_task_events(task_id,id);
INSERT INTO planner_task_events(task_id,revision,occurred_at,kind,reason,payload) SELECT id,json_extract(payload,'$.revision'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),'baseline','migration',json_object('stageId',json_extract(payload,'$.stageId'),'completed',EXISTS(SELECT 1 FROM planner_stages s WHERE s.id=json_extract(planner_tasks.payload,'$.stageId') AND json_extract(s.payload,'$.completed')=1),'assigneeId',NULL) FROM planner_tasks;
PRAGMA user_version=4;"))
}
pub fn stored_task(task: &Task) -> String {
    let mut value = serde_json::to_value(task).unwrap();
    value.as_object_mut().unwrap().remove("assigneeId");
    value.to_string()
}
pub fn validate_choice(
    conn: &Connection,
    id: &Option<String>,
    existing: &Option<String>,
    draft: bool,
) -> Result<()> {
    if let Some(id) = id {
        valid_id(id)?;
        let archived: Option<bool> = sql(conn
            .query_row(
                "SELECT archived FROM planner_assignees WHERE id=?",
                [id],
                |r| r.get(0),
            )
            .optional())?;
        match archived {
            None => return Err("Исполнитель больше не существует".into()),
            Some(true) if !draft && existing.as_ref() != Some(id) => {
                return Err("Исполнитель в архиве. Выберите другого или восстановите его.".into())
            }
            _ => {}
        }
    }
    Ok(())
}
pub fn record_changes(
    conn: &Connection,
    before: &Board,
    after: &Board,
    stage_settings: bool,
) -> Result<()> {
    let complete = |b: &Board, t: &Task| {
        b.stages
            .iter()
            .any(|s| Some(&s.id) == t.stage_id.as_ref() && s.completed)
    };
    let snapshot = |id: &Option<String>| -> Result<serde_json::Value> {
        Ok(match id {
            Some(id) => {
                serde_json::json!({"id":id,"name":sql(conn.query_row("SELECT name FROM planner_assignees WHERE id=?",[id],|r|r.get::<_,String>(0)))?})
            }
            None => serde_json::Value::Null,
        })
    };
    let previous_tasks: std::collections::HashMap<_, _> =
        before.tasks.iter().map(|t| (&t.id, t)).collect();
    for task in &after.tasks {
        let old = previous_tasks.get(&task.id).copied();
        let previous = old.and_then(|t| t.assignee_id.clone());
        let mut events = vec![];
        if previous != task.assignee_id {
            sql(conn.execute(
                "DELETE FROM planner_task_assignees WHERE task_id=?",
                [&task.id],
            ))?;
            if let Some(id) = &task.assignee_id {
                sql(conn.execute(
                    "INSERT INTO planner_task_assignees VALUES(?,?)",
                    params![task.id, id],
                ))?;
            }
            let kind = if previous.is_none() {
                "assigned"
            } else if task.assignee_id.is_none() {
                "unassigned"
            } else {
                "reassigned"
            };
            events.push((kind,serde_json::json!({"previous":snapshot(&previous)?,"current":snapshot(&task.assignee_id)?})));
        }
        if let Some(old) = old {
            if complete(before, old) != complete(after, task) {
                events.push((
                    if complete(after, task) {
                        "completed"
                    } else {
                        "reopened"
                    },
                    serde_json::json!({"assignee":snapshot(&task.assignee_id)?}),
                ));
            }
        }
        for (kind, payload) in events {
            sql(conn.execute("INSERT INTO planner_task_events(task_id,revision,occurred_at,kind,reason,payload) VALUES(?,?,?,?,?,?)",params![task.id,task.revision,Utc::now().to_rfc3339(),kind,if stage_settings{"stageSettings"}else{"task"},payload.to_string()]))?;
        }
    }
    Ok(())
}
impl Vault {
    pub fn assignees(&self) -> Result<Vec<Assignee>> {
        let mut s=sql(self.conn.prepare("SELECT id,name,archived,revision,created_at,updated_at FROM planner_assignees ORDER BY name_key,id"))?;
        let rows = sql(s.query_map([], |r| {
            Ok(Assignee {
                id: r.get(0)?,
                name: r.get(1)?,
                archived: r.get(2)?,
                revision: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
            })
        }))?;
        rows.map(sql).collect()
    }
    pub fn assignee_change(&mut self, change: Change) -> Result<Vec<Assignee>> {
        let tx = sql(self.conn.unchecked_transaction())?;
        let now = Utc::now().to_rfc3339();
        match change {
            Change::Create{id,name}=>{
                valid_id(&id)?; let (name,key)=normalized(&name)?;
                let existing:Option<String>=sql(tx.query_row("SELECT name_key FROM planner_assignees WHERE id=?",[&id],|r|r.get(0)).optional())?;
                if let Some(existing)=existing { if existing!=key { return Err("Идентификатор исполнителя уже используется".into()); } }
                else { self.unique_name(&key,&id)?; sql(tx.execute("INSERT INTO planner_assignees VALUES(?,?,?,0,1,?,?)",params![id,name,key,now,now]))?; }
            },
            Change::Rename{id,revision,name}=>{
                let(name,key)=normalized(&name)?; self.unique_name(&key,&id)?;
                if sql(tx.execute("UPDATE planner_assignees SET name=?,name_key=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",params![name,key,now,id,revision]))?!=1 {return Err("Исполнитель изменился. Список обновлён; повторите действие.".into());}
            },
            Change::Archive{id,revision,archived}=>{
                if sql(tx.execute("UPDATE planner_assignees SET archived=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",params![archived,now,id,revision]))?!=1 {return Err("Исполнитель изменился. Список обновлён; повторите действие.".into());}
            }
        }
        sql(tx.commit())?;
        self.assignees()
    }
    fn unique_name(&self, key: &str, id: &str) -> Result<()> {
        let duplicate: Option<bool> = sql(self
            .conn
            .query_row(
                "SELECT archived FROM planner_assignees WHERE name_key=? AND id!=?",
                params![key, id],
                |r| r.get(0),
            )
            .optional())?;
        match duplicate {
            Some(true) => {
                Err("Такой исполнитель уже в архиве. Покажите архивных и восстановите его.".into())
            }
            Some(false) => Err("Исполнитель с таким именем уже существует".into()),
            None => Ok(()),
        }
    }
    pub fn validate_assignees(&self) -> Result<()> {
        for a in self.assignees()? {
            valid_id(&a.id)?;
            let (name, key) = normalized(&a.name)?;
            let stored: String = sql(self.conn.query_row(
                "SELECT name_key FROM planner_assignees WHERE id=?",
                [&a.id],
                |r| r.get(0),
            ))?;
            if name != a.name || key != stored || a.revision < 1 {
                return Err("Повреждены данные исполнителей".into());
            }
            for date in [&a.created_at, &a.updated_at] {
                chrono::DateTime::parse_from_rfc3339(date)
                    .map_err(|_| "Повреждена дата исполнителя")?;
            }
        }
        let broken:i64=sql(self.conn.query_row("SELECT (SELECT count(*) FROM planner_task_assignees a LEFT JOIN planner_tasks t ON t.id=a.task_id LEFT JOIN planner_assignees p ON p.id=a.assignee_id WHERE t.id IS NULL OR p.id IS NULL)+(SELECT count(*) FROM planner_task_events e LEFT JOIN planner_tasks t ON t.id=e.task_id WHERE t.id IS NULL OR e.revision<1 OR NOT json_valid(e.payload))",[],|r|r.get(0)))?;
        if broken != 0 {
            return Err("Повреждены назначения или история задач".into());
        }
        let mut statement=sql(self.conn.prepare("SELECT e.kind,e.reason,e.occurred_at,e.payload,e.revision,json_extract(t.payload,'$.revision') FROM planner_task_events e JOIN planner_tasks t ON t.id=e.task_id"))?;
        let rows = sql(statement.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
            ))
        }))?;
        for row in rows {
            let (kind, reason, date, raw, revision, current) = sql(row)?;
            chrono::DateTime::parse_from_rfc3339(&date).map_err(|_| "Повреждена дата события")?;
            if revision > current
                || !["migration", "task", "stageSettings"].contains(&reason.as_str())
            {
                return Err("Повреждена история задач".into());
            }
            let payload: serde_json::Value =
                serde_json::from_str(&raw).map_err(|_| "Повреждена история задач")?;
            let keys = match kind.as_str() {
                "assigned" | "reassigned" | "unassigned" => vec!["previous", "current"],
                "completed" | "reopened" => vec!["assignee"],
                "baseline" => {
                    if reason != "migration"
                        || !payload["completed"].is_boolean() && !payload["completed"].is_number()
                    {
                        return Err("Повреждено начальное состояние".into());
                    }
                    vec![]
                }
                _ => return Err("Неизвестное событие задачи".into()),
            };
            for key in keys {
                let value = payload.get(key).ok_or("Повреждён снимок исполнителя")?;
                if !value.is_null() {
                    let id = value["id"]
                        .as_str()
                        .ok_or("Повреждён снимок исполнителя")?
                        .to_string();
                    validate_choice(&self.conn, &Some(id), &None, true)?;
                    normalized(value["name"].as_str().ok_or("Повреждено имя в истории")?)?;
                }
            }
        }
        Ok(())
    }
}
