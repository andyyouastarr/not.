use crate::{
    crypto::Result,
    planner::{Board, Task},
    vault::{valid_id, Vault},
};
use chrono::{DateTime, FixedOffset, Local};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;
fn sql<T>(r: rusqlite::Result<T>) -> Result<T> {
    r.map_err(|_| "Не удалось сохранить историю задачи".into())
}
pub const KINDS: &[&str] = &[
    "created",
    "moved",
    "assigned",
    "reassigned",
    "unassigned",
    "completed",
    "reopened",
    "edited",
    "archived",
    "unarchived",
    "deleted",
    "restored",
    "baseline",
];
pub struct Operation {
    id: String,
    time: DateTime<FixedOffset>,
}
impl Operation {
    pub fn new() -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            time: Local::now().fixed_offset(),
        }
    }
}
fn stage(b: &Board, t: &Task) -> Value {
    match &t.stage_id {
        None => json!({"id":null,"name":"Входящие"}),
        Some(id) => {
            json!({"id":id,"name":b.stages.iter().find(|s|&s.id==id).map(|s|s.title.as_str()).unwrap_or("Неизвестная стадия")})
        }
    }
}
fn person(conn: &Connection, id: &Option<String>) -> Result<Value> {
    Ok(match id {
        None => Value::Null,
        Some(id) => {
            json!({"id":id,"name":sql(conn.query_row("SELECT name FROM planner_assignees WHERE id=?",[id],|r|r.get::<_,String>(0)))?})
        }
    })
}
#[allow(clippy::too_many_arguments)] // Explicit transaction, operation and before/after snapshots.
pub fn write(
    conn: &Connection,
    op: &Operation,
    before: &Board,
    after: &Board,
    task: &Task,
    kind: &str,
    reason: &str,
    payload: Value,
) -> Result<()> {
    let old = before.tasks.iter().find(|t| t.id == task.id);
    let previous = old.and_then(|t| t.assignee_id.clone());
    let context = json!({"title":task.title,"from":old.map(|t|stage(before,t)),"to":stage(after,task),"assignee":person(conn,&task.assignee_id)?,"previousAssignee":person(conn,&previous)?,"completed":after.stages.iter().any(|s|Some(&s.id)==task.stage_id.as_ref()&&s.completed),"archived":task.archived,"deleted":task.deleted});
    sql(conn.execute("INSERT INTO planner_task_events(task_id,revision,occurred_at,kind,reason,payload,operation_id,local_date,utc_offset,epoch_ms,context,assignee_id,previous_assignee_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",params![task.id,task.revision,op.time.to_utc().to_rfc3339(),kind,reason,payload.to_string(),op.id,op.time.format("%Y-%m-%d").to_string(),op.time.offset().local_minus_utc(),op.time.timestamp_millis(),context.to_string(),task.assignee_id,previous]))?;
    Ok(())
}
pub fn schema(vault: &Vault) -> Result<()> {
    sql(vault.conn.execute_batch("ALTER TABLE planner_task_events ADD COLUMN operation_id TEXT;
ALTER TABLE planner_task_events ADD COLUMN local_date TEXT;
ALTER TABLE planner_task_events ADD COLUMN utc_offset INTEGER;
ALTER TABLE planner_task_events ADD COLUMN epoch_ms INTEGER;
ALTER TABLE planner_task_events ADD COLUMN context TEXT;
ALTER TABLE planner_task_events ADD COLUMN assignee_id TEXT;
ALTER TABLE planner_task_events ADD COLUMN previous_assignee_id TEXT;
CREATE INDEX history_task_time ON planner_task_events(task_id,epoch_ms,id);
CREATE INDEX history_day_time ON planner_task_events(local_date,epoch_ms,id);
CREATE INDEX history_assignee_day ON planner_task_events(assignee_id,local_date);
CREATE INDEX history_previous_assignee_day ON planner_task_events(previous_assignee_id,local_date);"))?;
    let mut stmt = sql(vault
        .conn
        .prepare("SELECT id,occurred_at,payload,kind FROM planner_task_events"))?;
    let rows = sql(stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    }))?;
    for row in rows {
        let (id, time, raw, kind) = sql(row)?;
        let date = DateTime::parse_from_rfc3339(&time).map_err(|_| "Повреждена дата истории")?;
        let p: Value = serde_json::from_str(&raw).map_err(|_| "Повреждена история")?;
        let current = if ["assigned", "reassigned", "unassigned"].contains(&kind.as_str()) {
            p["current"]["id"].as_str()
        } else {
            p["assignee"]["id"].as_str()
        };
        sql(vault.conn.execute("UPDATE planner_task_events SET epoch_ms=?,assignee_id=?,previous_assignee_id=? WHERE id=?",params![date.timestamp_millis(),current,p["previous"]["id"].as_str(),id]))?;
    }
    drop(stmt);
    let board = vault.planner()?;
    let op = Operation::new();
    for t in &board.tasks {
        write(
            &vault.conn,
            &op,
            &board,
            &board,
            t,
            "baseline",
            "migration",
            json!({"assigneeId":t.assignee_id,"stageId":t.stage_id,"completed":board.stages.iter().any(|s|Some(&s.id)==t.stage_id.as_ref()&&s.completed)}),
        )?;
    }
    sql(vault.conn.execute_batch("PRAGMA user_version=5;"))
}
pub fn record(
    conn: &Connection,
    op: &Operation,
    before: &Board,
    after: &Board,
    reason: &str,
) -> Result<()> {
    let old: std::collections::HashMap<_, _> = before.tasks.iter().map(|t| (&t.id, t)).collect();
    for t in &after.tasks {
        match old.get(&t.id) {
            None => write(conn, op, before, after, t, "created", reason, json!({}))?,
            Some(p) => {
                if p.stage_id != t.stage_id {
                    write(conn, op, before, after, t, "moved", reason, json!({}))?;
                }
                let mut fields = vec![];
                if p.title != t.title {
                    fields.push("title");
                }
                if p.document != t.document {
                    fields.push("document");
                }
                if p.deadline != t.deadline {
                    fields.push("deadline");
                }
                if !fields.is_empty() {
                    write(
                        conn,
                        op,
                        before,
                        after,
                        t,
                        "edited",
                        reason,
                        json!({"fields":fields}),
                    )?;
                }
                if p.archived != t.archived {
                    write(
                        conn,
                        op,
                        before,
                        after,
                        t,
                        if t.archived { "archived" } else { "unarchived" },
                        reason,
                        json!({}),
                    )?;
                }
                if p.deleted != t.deleted {
                    write(
                        conn,
                        op,
                        before,
                        after,
                        t,
                        if t.deleted { "deleted" } else { "restored" },
                        reason,
                        json!({}),
                    )?;
                }
            }
        }
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
pub enum AssigneeFilter {
    All,
    None,
    Person { id: String },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    pub task_id: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub assignee: AssigneeFilter,
    pub kinds: Vec<String>,
    pub cursor: Option<Cursor>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cursor {
    pub epoch_ms: i64,
    pub id: i64,
    pub through_id: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: i64,
    pub task_id: String,
    pub revision: i64,
    pub occurred_at: String,
    pub kind: String,
    pub reason: String,
    pub payload: Value,
    pub operation_id: Option<String>,
    pub local_date: Option<String>,
    pub utc_offset: Option<i32>,
    pub context: Option<Value>,
    pub incomplete: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub events: Vec<Event>,
    pub next: Option<Cursor>,
}
impl Vault {
    pub fn task_history(&self, q: Query) -> Result<Page> {
        if let Some(id) = &q.task_id {
            valid_id(id)?;
        }
        for d in [&q.from, &q.to].into_iter().flatten() {
            let date = chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d")
                .map_err(|_| "Неверная дата истории")?;
            if date.format("%Y-%m-%d").to_string() != *d {
                return Err("Неверная дата истории".into());
            }
        }
        if q.from.is_some() && q.to.is_some() && q.from > q.to {
            return Err("Неверный период".into());
        }
        if q.kinds.iter().any(|k| !KINDS.contains(&k.as_str())) {
            return Err("Неизвестный тип события".into());
        }
        let (mode, person) = match &q.assignee {
            AssigneeFilter::All => ("all", None),
            AssigneeFilter::None => ("none", None),
            AssigneeFilter::Person { id } => {
                valid_id(id)?;
                ("person", Some(id))
            }
        };
        let through = match &q.cursor {
            Some(c) => c.through_id,
            None => sql(self.conn.query_row(
                "SELECT coalesce(max(id),0) FROM planner_task_events",
                [],
                |r| r.get(0),
            ))?,
        };
        let query="SELECT id,task_id,revision,occurred_at,kind,reason,payload,operation_id,local_date,utc_offset,context,epoch_ms FROM planner_task_events WHERE id<=:through AND (:task IS NULL OR task_id=:task) AND (:from IS NULL OR local_date>=:from) AND (:to IS NULL OR local_date<=:to) AND (:has_cursor=0 OR epoch_ms>:epoch OR (epoch_ms=:epoch AND id>:id)) AND (:all_kinds=1 OR kind IN(SELECT value FROM json_each(:kinds))) AND (:mode='all' OR (:mode='none' AND ((context IS NOT NULL AND assignee_id IS NULL) OR (kind IN('assigned','reassigned','unassigned') AND (assignee_id IS NULL OR previous_assignee_id IS NULL)) OR (kind IN('completed','reopened') AND json_type(payload,'$.assignee')='null'))) OR (:mode='person' AND (assignee_id=:person OR (kind IN('assigned','reassigned','unassigned') AND previous_assignee_id=:person)))) ORDER BY epoch_ms,id LIMIT 201";
        let mut stmt = sql(self.conn.prepare(query))?;
        let raw=sql(stmt.query_map(rusqlite::named_params!{":through":through,":task":q.task_id,":from":q.from,":to":q.to,":has_cursor":q.cursor.is_some(),":epoch":q.cursor.as_ref().map(|c|c.epoch_ms).unwrap_or(0),":id":q.cursor.as_ref().map(|c|c.id).unwrap_or(0),":all_kinds":q.kinds.is_empty(),":kinds":serde_json::to_string(&q.kinds).unwrap(),":mode":mode,":person":person},|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?,r.get::<_,Option<String>>(7)?,r.get::<_,Option<String>>(8)?,r.get::<_,Option<i32>>(9)?,r.get::<_,Option<String>>(10)?,r.get::<_,i64>(11)?))))?;
        let mut events = vec![];
        let mut last = None;
        let mut more = false;
        for row in raw {
            let (
                id,
                task_id,
                revision,
                occurred_at,
                kind,
                reason,
                payload,
                operation_id,
                local_date,
                utc_offset,
                context,
                epoch_ms,
            ) = sql(row)?;
            if events.len() == 200 {
                more = true;
                break;
            }
            let incomplete = context.is_none();
            events.push(Event {
                id,
                task_id,
                revision,
                occurred_at,
                kind,
                reason,
                payload: serde_json::from_str(&payload).map_err(|_| "Повреждена история")?,
                operation_id,
                local_date,
                utc_offset,
                context: context
                    .map(|c| serde_json::from_str(&c))
                    .transpose()
                    .map_err(|_| "Повреждена история")?,
                incomplete,
            });
            last = Some(Cursor {
                epoch_ms,
                id,
                through_id: through,
            });
        }
        Ok(Page {
            events,
            next: if more { last } else { None },
        })
    }
    pub fn validate_history(&self) -> Result<()> {
        let board = self.planner()?;
        let mut cursor = None;
        loop {
            let page = self.task_history(Query {
                task_id: None,
                from: None,
                to: None,
                assignee: AssigneeFilter::All,
                kinds: vec![],
                cursor,
            })?;
            for e in page.events {
                let task = board
                    .tasks
                    .iter()
                    .find(|t| t.id == e.task_id)
                    .ok_or("История неизвестной задачи")?;
                if e.revision < 1 || e.revision > task.revision || !KINDS.contains(&e.kind.as_str())
                {
                    return Err("Повреждено событие".into());
                }
                let utc = DateTime::parse_from_rfc3339(&e.occurred_at)
                    .map_err(|_| "Повреждена дата события")?;
                let (epoch, indexed_person, indexed_previous): (i64, Option<String>, Option<String>) = sql(self.conn.query_row("SELECT epoch_ms,assignee_id,previous_assignee_id FROM planner_task_events WHERE id=?",[e.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))))?;
                if epoch != utc.timestamp_millis() {
                    return Err("Повреждено время истории".into());
                }
                if let Some(context) = e.context {
                    valid_id(e.operation_id.as_deref().ok_or("Нет операции")?)?;
                    let offset = FixedOffset::east_opt(e.utc_offset.ok_or("Нет часового пояса")?)
                        .ok_or("Неверный часовой пояс")?;
                    if Some(utc.with_timezone(&offset).format("%Y-%m-%d").to_string())
                        != e.local_date
                    {
                        return Err("Неверная локальная дата".into());
                    }
                    if !context["title"].is_string()
                        || context["title"]
                            .as_str()
                            .is_some_and(|s| s.chars().count() > 300)
                        || !context["to"].is_object()
                        || !context["completed"].is_boolean()
                        || !context["archived"].is_boolean()
                        || !context["deleted"].is_boolean()
                    {
                        return Err("Повреждено состояние истории".into());
                    }
                    if indexed_person.as_deref() != context["assignee"]["id"].as_str()
                        || indexed_previous.as_deref() != context["previousAssignee"]["id"].as_str()
                    {
                        return Err("Повреждён индекс исполнителя".into());
                    }
                    if e.kind == "edited"
                        && !e.payload["fields"].as_array().is_some_and(|fields| {
                            !fields.is_empty()
                                && fields.iter().all(|f| {
                                    f.as_str().is_some_and(|s| {
                                        ["title", "document", "deadline"].contains(&s)
                                    })
                                })
                        })
                    {
                        return Err("Повреждены поля правки".into());
                    }
                    for key in ["from", "to"] {
                        if !context[key].is_null() {
                            if !context[key]["name"].is_string() {
                                return Err("Повреждена стадия истории".into());
                            }
                            if let Some(id) = context[key]["id"].as_str() {
                                valid_id(id)?;
                            }
                        }
                    }
                    for key in ["assignee", "previousAssignee"] {
                        if !context[key].is_null() {
                            let id = context[key]["id"]
                                .as_str()
                                .ok_or("Повреждён исполнитель истории")?
                                .to_string();
                            crate::assignees::validate_choice(&self.conn, &Some(id), &None, true)?;
                            crate::assignees::normalized(
                                context[key]["name"]
                                    .as_str()
                                    .ok_or("Нет имени исполнителя")?,
                            )?;
                        }
                    }
                } else if e.operation_id.is_some()
                    || e.local_date.is_some()
                    || e.utc_offset.is_some()
                {
                    return Err("Повреждены старые события".into());
                }
            }
            cursor = page.next;
            if cursor.is_none() {
                break;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::planner::{Change, Draft};
    fn query() -> Query {
        Query {
            task_id: None,
            from: None,
            to: None,
            assignee: AssigneeFilter::All,
            kinds: vec![],
            cursor: None,
        }
    }
    fn draft() -> Draft {
        Draft {
            id: Uuid::new_v4().to_string(),
            title: "HistoryMarker".into(),
            document: json!({"type":"doc","content":[{"type":"paragraph"}]}),
            deadline: None,
            assignee_id: None,
            revision: 0,
        }
    }
    fn move_to(v: &mut Vault, stage: Option<String>) {
        let t = v.planner().unwrap().tasks[0].clone();
        v.planner_change(Change::Move {
            id: t.id,
            revision: t.revision,
            stage,
            before: None,
        })
        .unwrap();
    }
    #[test]
    fn atomic_events_snapshots_and_noop() {
        let dir = tempfile::tempdir().unwrap();
        let (mut v, key) = Vault::create(&dir.path().join("v"), "history test password").unwrap();
        let d = draft();
        v.planner_change(Change::Save { draft: d.clone() }).unwrap();
        assert_eq!(v.task_history(query()).unwrap().events.len(), 1);
        let mut same = d.clone();
        same.revision = 1;
        v.planner_change(Change::Save { draft: same }).unwrap();
        move_to(&mut v, None);
        v.planner_change(Change::Draft { draft: Some(d) }).unwrap();
        assert_eq!(v.task_history(query()).unwrap().events.len(), 1);
        let done = v.planner().unwrap().stages[2].id.clone();
        move_to(&mut v, Some(done.clone()));
        let events = v.task_history(query()).unwrap().events;
        assert_eq!(events.len(), 3);
        assert_eq!(events[1].operation_id, events[2].operation_id);
        assert_eq!(events[1].occurred_at, events[2].occurred_at);
        let moved = events.iter().find(|e| e.kind == "moved").unwrap();
        assert_eq!(moved.context.as_ref().unwrap()["to"]["name"], "Готово");
        let b = v.planner().unwrap();
        let mut stages = b.stages.clone();
        stages[2].title = "Renamed".into();
        v.planner_change(Change::Stages {
            stages,
            revision: b.revision,
            removed: None,
            destination: None,
        })
        .unwrap();
        assert_eq!(v.task_history(query()).unwrap().events.len(), 3);
        v.conn.execute_batch("CREATE TRIGGER fail_history BEFORE INSERT ON planner_task_events BEGIN SELECT RAISE(ABORT,'disk'); END;").unwrap();
        let t = v.planner().unwrap().tasks[0].clone();
        assert!(v
            .planner_change(Change::Move {
                id: t.id.clone(),
                revision: t.revision,
                stage: None,
                before: None
            })
            .is_err());
        assert_eq!(v.planner().unwrap().tasks[0].stage_id, Some(done.clone()));
        assert_eq!(v.planner().unwrap().tasks[0].revision, t.revision);
        v.conn.execute_batch("DROP TRIGGER fail_history;").unwrap();
        let b = v.planner().unwrap();
        v.planner_change(Change::Stages {
            stages: b.stages.into_iter().filter(|s| s.id != done).collect(),
            revision: b.revision,
            removed: Some(done),
            destination: None,
        })
        .unwrap();
        let events = v.task_history(query()).unwrap().events;
        assert!(events
            .iter()
            .any(|e| e.kind == "moved" && e.reason == "stageSettings"));
        v.validate_history().unwrap();
        let backup = dir.path().join("history.notbackup");
        v.backup(&backup).unwrap();
        let restored = Vault::restore(&backup, &dir.path().join("restored"), &key, true).unwrap();
        assert_eq!(
            restored.task_history(query()).unwrap().events.len(),
            events.len()
        );
    }
    #[test]
    fn historical_assignee_and_edit_fields() {
        let dir = tempfile::tempdir().unwrap();
        let (mut v, _) = Vault::create(&dir.path().join("v"), "history test password").unwrap();
        let a = Uuid::new_v4().to_string();
        let b = Uuid::new_v4().to_string();
        for (id, name) in [(&a, "Anna"), (&b, "Boris")] {
            v.assignee_change(crate::assignees::Change::Create {
                id: id.clone(),
                name: name.into(),
            })
            .unwrap();
        }
        let mut d = draft();
        d.assignee_id = Some(a.clone());
        v.planner_change(Change::Save { draft: d.clone() }).unwrap();
        d.revision = 1;
        d.assignee_id = Some(b.clone());
        d.title = "New title".into();
        d.deadline = Some("2027-01-02".into());
        d.document = json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Never copy private body into events"}]}]});
        v.planner_change(Change::Save { draft: d.clone() }).unwrap();
        let all = v.task_history(query()).unwrap().events;
        let edit = all.iter().find(|e| e.kind == "edited").unwrap();
        assert_eq!(
            edit.payload,
            json!({"fields":["title","document","deadline"]})
        );
        assert_eq!(edit.context.as_ref().unwrap()["assignee"]["id"], b);
        let assignment = all.iter().find(|e| e.kind == "reassigned").unwrap();
        assert_eq!(edit.operation_id, assignment.operation_id);
        let mut q = query();
        q.assignee = AssigneeFilter::Person { id: a.clone() };
        let a_events = v.task_history(q).unwrap().events;
        assert!(a_events.iter().any(|e| e.kind == "reassigned"));
        assert!(!a_events.iter().any(|e| e.kind == "edited"));
        v.assignee_change(crate::assignees::Change::Rename {
            id: b.clone(),
            revision: 1,
            name: "Renamed".into(),
        })
        .unwrap();
        d.revision = 2;
        d.assignee_id = None;
        v.planner_change(Change::Save { draft: d }).unwrap();
        let mut q = query();
        q.assignee = AssigneeFilter::None;
        assert!(v
            .task_history(q)
            .unwrap()
            .events
            .iter()
            .any(|e| e.kind == "unassigned"));
        let mut q = query();
        q.assignee = AssigneeFilter::Person { id: b };
        let events = v.task_history(q).unwrap().events;
        assert_eq!(
            events
                .iter()
                .find(|e| e.kind == "edited")
                .unwrap()
                .context
                .as_ref()
                .unwrap()["assignee"]["name"],
            "Boris"
        );
        assert!(!serde_json::to_string(&events)
            .unwrap()
            .contains("Never copy private body"));
        v.validate_history().unwrap();
    }
    #[test]
    fn paging_offsets_filters_and_incomplete_migration() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("v");
        let (mut v, _) = Vault::create(&root, "history test password").unwrap();
        v.planner_change(Change::Save { draft: draft() }).unwrap();
        // A real schema-4 table with a preserved old completion event.
        v.conn.execute_batch("DROP TABLE planner_task_events; CREATE TABLE planner_task_events(id INTEGER PRIMARY KEY,task_id TEXT NOT NULL REFERENCES planner_tasks(id),revision INTEGER NOT NULL,occurred_at TEXT NOT NULL,kind TEXT NOT NULL,reason TEXT NOT NULL,payload TEXT NOT NULL); PRAGMA user_version=4;").unwrap();
        let t = v.planner().unwrap().tasks[0].clone();
        v.conn.execute("INSERT INTO planner_task_events VALUES(1,?,1,'2026-01-01T23:59:00Z','completed','task','{\"assignee\":null}')",[&t.id]).unwrap();
        drop(v);
        let v = Vault::open(&root, "history test password", false).unwrap();
        let p = v.task_history(query()).unwrap();
        assert_eq!(p.events.len(), 2);
        assert!(p.events[0].incomplete);
        assert!(p.events[0].local_date.is_none());
        assert_eq!(p.events[0].occurred_at, "2026-01-01T23:59:00Z");
        assert_eq!(p.events[1].kind, "baseline");
        assert!(dir.path().join("migration-backups").exists());
        let b = v.planner().unwrap();
        let op = Operation {
            id: Uuid::new_v4().to_string(),
            time: DateTime::parse_from_rfc3339("2027-01-02T00:01:03+10:00").unwrap(),
        };
        for _ in 0..405 {
            write(&v.conn, &op, &b, &b, &t, "moved", "task", json!({})).unwrap();
        }
        let mut q = query();
        q.from = Some("2027-01-02".into());
        q.to = q.from.clone();
        let first = v.task_history(q).unwrap();
        assert_eq!(first.events.len(), 200);
        assert!(first
            .events
            .iter()
            .all(|e| e.utc_offset == Some(36000) && e.local_date.as_deref() == Some("2027-01-02")));
        // New data after page one must not leak into its snapshot.
        write(&v.conn, &op, &b, &b, &t, "moved", "task", json!({})).unwrap();
        let mut ids = first.events.iter().map(|e| e.id).collect::<Vec<_>>();
        let mut cursor = first.next;
        while cursor.is_some() {
            let mut q = query();
            q.from = Some("2027-01-02".into());
            q.to = q.from.clone();
            q.cursor = cursor;
            let p = v.task_history(q).unwrap();
            ids.extend(p.events.iter().map(|e| e.id));
            cursor = p.next;
        }
        assert_eq!(ids.len(), 405);
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 405);
        let mut q = query();
        q.from = Some("2026-01-01".into());
        q.to = q.from.clone();
        assert!(v.task_history(q).unwrap().events.is_empty());
        v.validate_history().unwrap();
    }
}
