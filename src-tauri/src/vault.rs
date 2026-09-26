use crate::crypto::{self, Manifest, Master, Result};
use chrono::{Local, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;
use zeroize::Zeroize;

const DB: &str = "journal.db";
const MANIFEST: &str = "vault.json";
const INCOMPLETE_ATTACHMENT: &str =
    "Вложение сохранено не полностью. Добавьте исходный файл заново (ошибка старой версии).";
#[track_caller]
fn io<T>(r: std::io::Result<T>) -> Result<T> {
    #[cfg(debug_assertions)]
    let line = std::panic::Location::caller().line();
    r.map_err(|error| {
        #[cfg(debug_assertions)]
        eprintln!(
            "vault I/O failure at line {line}: kind={:?}, code={:?}",
            error.kind(),
            error.raw_os_error()
        );
        let _ = error;
        "Не удалось прочитать или записать файл. Проверьте свободное место и доступ.".into()
    })
}
fn sql<T>(r: rusqlite::Result<T>) -> Result<T> {
    r.map_err(|_| "Не удалось выполнить операцию с хранилищем".into())
}
pub fn rename_directory(source: &Path, destination: &Path) -> Result<()> {
    // Windows indexers and scanners can briefly hold newly closed database files.
    // Retry only sharing/access errors; keep the original directory on failure.
    for attempt in 0..20 {
        match fs::rename(source, destination) {
            Ok(()) => return Ok(()),
            Err(error)
                if cfg!(windows)
                    && matches!(error.raw_os_error(), Some(5 | 32 | 33))
                    && attempt < 19 =>
            {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return io(Err(error)),
        }
    }
    unreachable!()
}
pub fn atomic(path: &Path, data: &[u8]) -> Result<()> {
    let mut tmp = io(tempfile::NamedTempFile::new_in(
        path.parent().ok_or("Неверный путь")?,
    ))?;
    io(tmp.write_all(data))?;
    io(tmp.as_file().sync_all())?;
    tmp.persist(path)
        .map_err(|_| "Не удалось завершить запись файла")?;
    Ok(())
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub date: String,
    pub title: String,
    pub document: Value,
    pub favorite: bool,
    pub deleted: bool,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub date: String,
    pub title: String,
    pub excerpt: String,
    pub favorite: bool,
    pub deleted: bool,
    pub updated_at: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveEntry {
    pub id: String,
    pub date: String,
    pub title: String,
    pub document: Value,
    pub revision: i64,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
}
pub struct Vault {
    pub root: PathBuf,
    pub conn: Connection,
    pub master: Master,
    pub manifest: Manifest,
}
fn connect(path: &Path, master: &Master) -> Result<Connection> {
    let conn = sql(Connection::open(path))?;
    let mut key = master.database_hex();
    let mut pragma = format!("PRAGMA key=\"x'{key}'\";");
    let result = conn.execute_batch(&pragma);
    key.zeroize();
    pragma.zeroize();
    sql(result)?;
    let cipher: Option<String> = sql(conn
        .query_row("PRAGMA cipher_version", [], |r| r.get(0))
        .optional())?;
    if cipher.is_none() {
        return Err("SQLCipher недоступен. Незашифрованное хранение запрещено.".into());
    }
    sql(conn.execute_batch("PRAGMA cipher_memory_security=ON; PRAGMA temp_store=MEMORY; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;"))?;
    sql(conn.busy_timeout(Duration::from_secs(5)))?;
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
        r.get::<_, i64>(0)
    })
    .map_err(|_| crypto::AUTH_ERROR)?;
    Ok(conn)
}
fn schema(conn: &Connection) -> Result<()> {
    sql(conn.execute_batch("BEGIN IMMEDIATE;
CREATE TABLE entries(id TEXT PRIMARY KEY,date TEXT NOT NULL,title TEXT NOT NULL,document TEXT NOT NULL,text TEXT NOT NULL,favorite INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1);
CREATE INDEX entry_dates ON entries(deleted,date DESC,created_at DESC);
CREATE VIRTUAL TABLE entry_fts USING fts5(id UNINDEXED,title,text,tokenize='unicode61');
CREATE TABLE attachments(id TEXT PRIMARY KEY,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL);
CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
PRAGMA user_version=1; COMMIT;"))
}
pub fn valid_id(id: &str) -> Result<()> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "Неверный идентификатор".into())
}
fn plain_text(node: &Value, out: &mut String) {
    if let Some(t) = node.get("text").and_then(Value::as_str) {
        out.push_str(t);
        out.push(' ');
    }
    if let Some(c) = node.get("content").and_then(Value::as_array) {
        for n in c {
            plain_text(n, out)
        }
    }
}
fn has_structure(node: &Value) -> bool {
    matches!(node["type"].as_str(), Some("table" | "horizontalRule"))
        || node["content"]
            .as_array()
            .is_some_and(|c| c.iter().any(has_structure))
}
pub fn highlight_color(name: &str) -> Option<&'static str> {
    match name {
        "lavender" => Some("#e3d9f7"),
        "yellow" => Some("#f3e5ae"),
        "green" => Some("#cce9d9"),
        "pink" => Some("#f0d3e0"),
        _ => None,
    }
}
pub fn validate_document(doc: &Value) -> Result<Vec<String>> {
    fn walk(v: &Value, depth: usize, ids: &mut Vec<String>, count: &mut usize) -> Result<()> {
        *count += 1;
        if depth > 32 || *count > 30000 {
            return Err("Документ слишком сложный".into());
        }
        let kind = v
            .get("type")
            .and_then(Value::as_str)
            .ok_or("Неверный блок документа")?;
        if ![
            "doc",
            "paragraph",
            "text",
            "heading",
            "bulletList",
            "orderedList",
            "listItem",
            "taskList",
            "taskItem",
            "blockquote",
            "horizontalRule",
            "hardBreak",
            "codeBlock",
            "table",
            "tableRow",
            "tableCell",
            "tableHeader",
            "image",
            "attachment",
        ]
        .contains(&kind)
        {
            return Err("Неизвестный тип блока".into());
        }
        if kind == "image" || kind == "attachment" {
            let id = v
                .pointer("/attrs/attachmentId")
                .and_then(Value::as_str)
                .ok_or("Вложение не сохранено")?;
            valid_id(id)?;
            ids.push(id.to_owned());
            if v.pointer("/attrs/src")
                .is_some_and(|x| !x.is_null() && x.as_str() != Some(""))
            {
                return Err("Внешние изображения запрещены".into());
            }
        }
        if kind == "image" {
            if let Some(width) = v.pointer("/attrs/widthPercent").filter(|x| !x.is_null()) {
                if !width.as_f64().is_some_and(|w| (15.0..=100.0).contains(&w)) {
                    return Err("Неверный размер изображения".into());
                }
            }
            if let Some(layout) = v.pointer("/attrs/layout").filter(|x| !x.is_null()) {
                if !layout
                    .as_str()
                    .is_some_and(|s| ["block", "left", "right"].contains(&s))
                {
                    return Err("Неверное размещение изображения".into());
                }
            }
        }
        if let Some(marks) = v.get("marks").and_then(Value::as_array) {
            for m in marks {
                let t = m.get("type").and_then(Value::as_str).unwrap_or("");
                if ![
                    "bold",
                    "italic",
                    "strike",
                    "code",
                    "underline",
                    "link",
                    "highlight",
                ]
                .contains(&t)
                {
                    return Err("Неизвестное форматирование".into());
                }
                if t == "highlight"
                    && highlight_color(m["attrs"]["color"].as_str().unwrap_or("")).is_none()
                {
                    return Err("Неверный цвет маркера".into());
                }
                if t == "link" {
                    let href = m
                        .pointer("/attrs/href")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if !safe_link(href) {
                        return Err("Допустимы только ссылки https, http и mailto".into());
                    }
                }
            }
        }
        if let Some(c) = v.get("content").and_then(Value::as_array) {
            for n in c {
                walk(n, depth + 1, ids, count)?;
            }
        }
        Ok(())
    }
    if doc.get("type").and_then(Value::as_str) != Some("doc")
        || doc.to_string().len() > 4 * 1024 * 1024
    {
        return Err("Неверный или слишком большой документ".into());
    }
    let mut ids = vec![];
    walk(doc, 0, &mut ids, &mut 0)?;
    Ok(ids)
}
pub fn safe_link(s: &str) -> bool {
    ["https://", "http://", "mailto:"]
        .iter()
        .any(|p| s.starts_with(p))
        && !s.chars().any(char::is_control)
}
impl Vault {
    pub fn pending_recovery(&self) -> Result<Option<String>> {
        sql(self
            .conn
            .query_row(
                "SELECT value FROM settings WHERE key='pending_recovery'",
                [],
                |r| r.get(0),
            )
            .optional())
    }
    pub fn clear_pending_recovery(&self) -> Result<()> {
        sql(self
            .conn
            .execute("DELETE FROM settings WHERE key='pending_recovery'", []))?;
        Ok(())
    }
    pub fn create(root: &Path, password: &str) -> Result<(Self, String)> {
        crypto::init()?;
        if root.exists() {
            return Err("Хранилище уже существует".into());
        }
        let (manifest, master, recovery) = crypto::create(password)?;
        let parent = root.parent().ok_or("Неверный путь")?;
        io(fs::create_dir_all(parent))?;
        let staging = io(tempfile::tempdir_in(parent))?;
        io(fs::create_dir(staging.path().join("files")))?;
        atomic(
            &staging.path().join(MANIFEST),
            &serde_json::to_vec(&manifest).unwrap(),
        )?;
        let conn = connect(&staging.path().join(DB), &master)?;
        schema(&conn)?;
        sql(conn.execute(
            "INSERT INTO settings(key,value) VALUES('pending_recovery',?)",
            [&recovery],
        ))?;
        drop(conn);
        rename_directory(staging.path(), root)?;
        let conn = connect(&root.join(DB), &master)?;
        Ok((
            Self {
                root: root.into(),
                conn,
                master,
                manifest,
            },
            recovery,
        ))
    }
    pub fn open(root: &Path, credential: &str, recovery: bool) -> Result<Self> {
        crypto::init()?;
        let data = io(fs::read(root.join(MANIFEST)))?;
        if data.len() > 8192 {
            return Err(crypto::AUTH_ERROR.into());
        }
        let manifest: Manifest = serde_json::from_slice(&data).map_err(|_| crypto::AUTH_ERROR)?;
        let master = crypto::unlock(&manifest, credential, recovery)?;
        let conn = connect(&root.join(DB), &master)?;
        let version: i64 = sql(conn.query_row("PRAGMA user_version", [], |r| r.get(0)))?;
        if version != 1 {
            return Err("Версия базы не поддерживается. Обновите приложение.".into());
        }
        Ok(Self {
            root: root.into(),
            conn,
            master,
            manifest,
        })
    }
    pub fn save(&mut self, e: SaveEntry) -> Result<Entry> {
        valid_id(&e.id)?;
        chrono::NaiveDate::parse_from_str(&e.date, "%Y-%m-%d").map_err(|_| "Неверная дата")?;
        if e.title.chars().count() > 300 {
            return Err("Заголовок длиннее 300 символов".into());
        }
        let ids = validate_document(&e.document)?;
        for id in &ids {
            if self.attachment(id).is_err() {
                return Err("Вложение недоступно".into());
            }
        }
        let mut text = String::new();
        plain_text(&e.document, &mut text);
        if text.trim().is_empty()
            && e.title.trim().is_empty()
            && ids.is_empty()
            && !has_structure(&e.document)
            && e.revision == 0
        {
            return Err("Пустая запись не сохраняется".into());
        }
        let now = Utc::now().to_rfc3339();
        let tx = sql(self.conn.transaction())?;
        let old: Option<(i64, bool)> = sql(tx
            .query_row(
                "SELECT revision,deleted FROM entries WHERE id=?",
                [&e.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional())?;
        if old.is_some_and(|(r, d)| r != e.revision || d) || old.is_none() && e.revision != 0 {
            return Err("Запись изменилась. Откройте её заново перед сохранением.".into());
        }
        sql(tx.execute("INSERT INTO entries(id,date,title,document,text,created_at,updated_at,revision) VALUES(?1,?2,?3,?4,?5,?6,?6,1) ON CONFLICT(id) DO UPDATE SET date=excluded.date,title=excluded.title,document=excluded.document,text=excluded.text,updated_at=excluded.updated_at,revision=entries.revision+1",params![e.id,e.date,e.title,serde_json::to_string(&e.document).unwrap(),text,now]))?;
        sql(tx.execute("DELETE FROM entry_fts WHERE id=?", [&e.id]))?;
        sql(tx.execute(
            "INSERT INTO entry_fts(id,title,text) VALUES(?,?,?)",
            params![e.id, e.title, text],
        ))?;
        sql(tx.commit())?;
        self.get(&e.id)
    }
    pub fn get(&self, id: &str) -> Result<Entry> {
        valid_id(id)?;
        let entry = sql(self.conn.query_row("SELECT id,date,title,document,favorite,deleted,created_at,updated_at,revision FROM entries WHERE id=?",[id],|r|{let raw:String=r.get(3)?;Ok(Entry{id:r.get(0)?,date:r.get(1)?,title:r.get(2)?,document:serde_json::from_str(&raw).map_err(|e|rusqlite::Error::FromSqlConversionFailure(3,rusqlite::types::Type::Text,Box::new(e)))?,favorite:r.get(4)?,deleted:r.get(5)?,created_at:r.get(6)?,updated_at:r.get(7)?,revision:r.get(8)?})} ))?;
        validate_document(&entry.document)?;
        Ok(entry)
    }
    pub fn list(&self, query: &str, filter: &str, date: &str, offset: u32) -> Result<Vec<Summary>> {
        if query.len() > 500
            || !date.is_empty() && chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err()
        {
            return Err("Неверные параметры поиска".into());
        }
        let search = query
            .split_whitespace()
            .take(16)
            .map(|s| format!("\"{}\"*", s.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND ");
        let query_sql=format!("SELECT e.id,e.date,e.title,substr(e.text,1,160),e.favorite,e.deleted,e.updated_at FROM entries e WHERE e.deleted=?1 AND (?2=0 OR e.favorite=1) AND (?3='' OR e.date=?3) {} ORDER BY e.date DESC,e.created_at DESC LIMIT 60 OFFSET ?4",if search.is_empty(){""}else{"AND e.id IN (SELECT id FROM entry_fts WHERE entry_fts MATCH ?5)"});
        let mut stmt = sql(self.conn.prepare(&query_sql))?;
        let map = |r: &rusqlite::Row| {
            Ok(Summary {
                id: r.get(0)?,
                date: r.get(1)?,
                title: r.get(2)?,
                excerpt: r.get(3)?,
                favorite: r.get(4)?,
                deleted: r.get(5)?,
                updated_at: r.get(6)?,
            })
        };
        let rows = if search.is_empty() {
            sql(stmt.query_map(
                params![filter == "trash", filter == "favorites", date, offset],
                map,
            ))?
        } else {
            sql(stmt.query_map(
                params![
                    filter == "trash",
                    filter == "favorites",
                    date,
                    offset,
                    search
                ],
                map,
            ))?
        };
        sql(rows.collect())
    }
    pub fn toggle(&mut self, id: &str, field: &str, value: bool) -> Result<()> {
        valid_id(id)?;
        let column = match field {
            "favorite" => "favorite",
            "deleted" => "deleted",
            _ => return Err("Неверное действие".into()),
        };
        sql(self.conn.execute(
            &format!(
                "UPDATE entries SET {column}=?1,updated_at=?2,revision=revision+1 WHERE id=?3"
            ),
            params![value, Utc::now().to_rfc3339(), id],
        ))?;
        Ok(())
    }
    pub fn settings(&self) -> Result<Value> {
        let raw: Option<String> = sql(self
            .conn
            .query_row(
                "SELECT value FROM settings WHERE key='preferences'",
                [],
                |r| r.get(0),
            )
            .optional())?;
        Ok(raw.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(
            serde_json::json!({"opaque":false,"lastEntry":null,"recoveryConfirmed":false}),
        ))
    }
    pub fn set_settings(&self, value: Value) -> Result<()> {
        if value.to_string().len() > 4096 {
            return Err("Настройки слишком большие".into());
        }
        sql(self.conn.execute("INSERT INTO settings(key,value) VALUES('preferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[value.to_string()]))?;
        Ok(())
    }
    pub fn change_password(&mut self, password: &str) -> Result<()> {
        let mut next = self.manifest.clone();
        crypto::change_password(&mut next, &self.master, password)?;
        atomic(
            &self.root.join(MANIFEST),
            &serde_json::to_vec(&next).unwrap(),
        )?;
        self.manifest = next;
        Ok(())
    }
    pub fn attachment(&self, id: &str) -> Result<Attachment> {
        valid_id(id)?;
        sql(self.conn.query_row(
            "SELECT id,name,mime,size FROM attachments WHERE id=?",
            [id],
            |r| {
                Ok(Attachment {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    mime: r.get(2)?,
                    size: r.get(3)?,
                })
            },
        ))
    }
    pub fn add_attachment(&self, path: &Path) -> Result<Attachment> {
        let size = io(fs::metadata(path))?.len();
        if size > 25 * 1024 * 1024 {
            return Err("Максимальный размер вложения — 25 МБ".into());
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("Неверное имя файла")?
            .to_string();
        let mut input = io(File::open(path))?;
        let mut header = [0; 12];
        let n = io(input.read(&mut header))?;
        drop(input);
        let mime = if n >= 8 && header.starts_with(b"\x89PNG\r\n\x1a\n") {
            "image/png"
        } else if n >= 3 && header.starts_with(&[255, 216, 255]) {
            "image/jpeg"
        } else if n >= 6 && (&header[..6] == b"GIF89a" || &header[..6] == b"GIF87a") {
            "image/gif"
        } else if n == 12 && &header[..4] == b"RIFF" && &header[8..] == b"WEBP" {
            "image/webp"
        } else {
            "application/octet-stream"
        };
        self.store_attachment(io(File::open(path))?, name, mime, size)
    }
    pub fn add_pasted_image(&self, data: &[u8]) -> Result<Attachment> {
        if data.is_empty() || data.len() > 25 * 1024 * 1024 {
            return Err("Максимальный размер изображения — 25 МБ".into());
        }
        let mut decoder = png::Decoder::new(data);
        decoder.set_limits(png::Limits {
            bytes: 64 * 1024 * 1024,
        });
        let mut reader = decoder
            .read_info()
            .map_err(|_| "Некорректное PNG-изображение")?;
        let info = reader.info();
        if info.width == 0
            || info.height == 0
            || u64::from(info.width) * u64::from(info.height) > 16_000_000
            || reader.output_buffer_size() > 64 * 1024 * 1024
        {
            return Err("Изображение слишком большое: максимум 16 миллионов пикселей".into());
        }
        let mut pixels = zeroize::Zeroizing::new(vec![0; reader.output_buffer_size()]);
        reader
            .next_frame(&mut pixels)
            .map_err(|_| "Изображение повреждено")?;
        self.store_attachment(
            data,
            format!(
                "Вставленное изображение {}.png",
                Local::now().format("%Y-%m-%d %H-%M-%S")
            ),
            "image/png",
            data.len() as u64,
        )
    }
    fn store_attachment(
        &self,
        input: impl Read,
        name: String,
        mime: &str,
        size: u64,
    ) -> Result<Attachment> {
        let a = Attachment {
            id: Uuid::new_v4().to_string(),
            name,
            mime: mime.into(),
            size,
        };
        let dest = self.root.join("files").join(&a.id);
        let mut tmp = io(tempfile::NamedTempFile::new_in(self.root.join("files")))?;
        crypto::encrypt_file(input, tmp.as_file_mut(), &self.master)?;
        io(tmp.as_file().sync_all())?;
        let written =
            crypto::decrypt_file(io(File::open(tmp.path()))?, std::io::sink(), &self.master)?;
        if written != size {
            return Err("Файл изменился во время добавления. Повторите операцию.".into());
        }
        tmp.persist(&dest)
            .map_err(|_| "Не удалось сохранить вложение")?;
        if let Err(e) = sql(self.conn.execute(
            "INSERT INTO attachments(id,name,mime,size) VALUES(?,?,?,?)",
            params![a.id, a.name, a.mime, a.size],
        )) {
            let _ = fs::remove_file(dest);
            return Err(e);
        }
        Ok(a)
    }
    pub fn read_attachment(&self, id: &str) -> Result<Vec<u8>> {
        let a = self.attachment(id)?;
        if a.size > 25 * 1024 * 1024 {
            return Err("Вложение превышает 25 МБ".into());
        }
        let mut out = Vec::with_capacity(a.size as usize);
        let size = crypto::decrypt_file(
            io(File::open(self.root.join("files").join(id)))?,
            &mut out,
            &self.master,
        )?;
        if size != a.size {
            out.zeroize();
            return Err(INCOMPLETE_ATTACHMENT.into());
        }
        Ok(out)
    }
    pub fn write_attachment(&self, id: &str, path: &Path) -> Result<()> {
        let a = self.attachment(id)?;
        let mut tmp = io(tempfile::NamedTempFile::new_in(
            path.parent().ok_or("Неверный путь")?,
        ))?;
        let size = crypto::decrypt_file(
            io(File::open(self.root.join("files").join(id)))?,
            tmp.as_file_mut(),
            &self.master,
        )?;
        if size != a.size {
            return Err(INCOMPLETE_ATTACHMENT.into());
        }
        io(tmp.as_file().sync_all())?;
        tmp.persist(path).map_err(|_| "Не удалось сохранить файл")?;
        Ok(())
    }
    pub fn backup(&self, dest: &Path) -> Result<()> {
        let staging = io(tempfile::tempdir_in(
            self.root.parent().ok_or("Неверный путь")?,
        ))?;
        let mut snapshot = connect(&staging.path().join(DB), &self.master)?;
        {
            let backup = sql(rusqlite::backup::Backup::new(&self.conn, &mut snapshot))?;
            sql(backup.run_to_completion(128, Duration::from_millis(1), None))?;
        }
        drop(snapshot);
        let mut tmp = io(tempfile::NamedTempFile::new_in(
            dest.parent().ok_or("Неверный путь")?,
        ))?;
        {
            let mut zip = zip::ZipWriter::new(tmp.as_file_mut());
            let opt = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zip.start_file(MANIFEST, opt).map_err(|_| "Ошибка архива")?;
            io(zip.write_all(&serde_json::to_vec(&self.manifest).unwrap()))?;
            zip.start_file(DB, opt).map_err(|_| "Ошибка архива")?;
            io(std::io::copy(
                &mut io(File::open(staging.path().join(DB)))?,
                &mut zip,
            ))?;
            for item in io(fs::read_dir(self.root.join("files")))? {
                let item = io(item)?;
                let name = item.file_name().to_string_lossy().into_owned();
                if valid_id(&name).is_err() {
                    continue;
                }
                zip.start_file(format!("files/{name}"), opt)
                    .map_err(|_| "Ошибка архива")?;
                io(std::io::copy(&mut io(File::open(item.path()))?, &mut zip))?;
            }
            zip.finish().map_err(|_| "Ошибка архива")?;
        }
        io(tmp.as_file().sync_all())?;
        tmp.persist(dest)
            .map_err(|_| "Не удалось завершить резервную копию")?;
        Ok(())
    }
    pub fn daily_backup(&self) -> Result<()> {
        let dir = self.root.parent().unwrap().join("backups");
        io(fs::create_dir_all(&dir))?;
        let dest = dir.join(format!("{}.notbackup", Local::now().format("%Y-%m-%d")));
        if !dest.exists() {
            self.backup(&dest)?;
        }
        let mut files = io(fs::read_dir(&dir))?
            .filter_map(|x| x.ok())
            .filter(|x| x.path().extension().is_some_and(|s| s == "notbackup"))
            .collect::<Vec<_>>();
        files.sort_by_key(|x| x.file_name());
        let excess = files.len().saturating_sub(7);
        for f in files.into_iter().take(excess) {
            io(fs::remove_file(f.path()))?;
        }
        Ok(())
    }
    pub fn restore(
        archive: &Path,
        destination: &Path,
        credential: &str,
        recovery: bool,
    ) -> Result<Self> {
        if destination.exists() {
            return Err("Для восстановления требуется свободная папка".into());
        }
        let parent = destination.parent().ok_or("Неверный путь")?;
        io(fs::create_dir_all(parent))?;
        let staging = io(tempfile::tempdir_in(parent))?;
        io(fs::create_dir(staging.path().join("files")))?;
        let mut zip = zip::ZipArchive::new(io(File::open(archive))?)
            .map_err(|_| "Неверная резервная копия")?;
        if zip.len() > 100_000 {
            return Err("Слишком большой архив".into());
        }
        let mut seen = std::collections::HashSet::new();
        let mut total = 0u64;
        for i in 0..zip.len() {
            let mut file = zip.by_index(i).map_err(|_| "Повреждённый архив")?;
            let name = file.name().to_owned();
            let valid = name == DB
                || name == MANIFEST
                || name
                    .strip_prefix("files/")
                    .is_some_and(|id| valid_id(id).is_ok());
            if !valid
                || !seen.insert(name.clone())
                || file.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
            {
                return Err("Недопустимый файл в архиве".into());
            }
            let limit = if name == MANIFEST {
                8192
            } else if name == DB {
                512 * 1024 * 1024
            } else {
                26 * 1024 * 1024
            };
            if file.size() > limit {
                return Err("Слишком большой файл в архиве".into());
            }
            total += file.size();
            if total > 4 * 1024 * 1024 * 1024 {
                return Err("Архив превышает 4 ГБ".into());
            }
            let mut out = io(File::create(staging.path().join(&name)))?;
            let copied = io(std::io::copy(&mut file.by_ref().take(limit + 1), &mut out))?;
            if copied > limit {
                return Err("Слишком большой файл в архиве".into());
            }
            io(out.sync_all())?;
        }
        let vault = Self::open(staging.path(), credential, recovery)?;
        let check: String = sql(vault
            .conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0)))?;
        if check != "ok" {
            return Err("База в резервной копии повреждена".into());
        }
        let mut stmt = sql(vault.conn.prepare("SELECT id FROM attachments"))?;
        let ids = sql(stmt.query_map([], |r| r.get::<_, String>(0)))?
            .collect::<rusqlite::Result<Vec<_>>>();
        for id in sql(ids)? {
            crypto::decrypt_file(
                io(File::open(staging.path().join("files").join(&id)))?,
                std::io::sink(),
                &vault.master,
            )?;
        }
        drop(stmt);
        let mut stmt = sql(vault.conn.prepare("SELECT document FROM entries"))?;
        for raw in sql(stmt.query_map([], |r| r.get::<_, String>(0)))? {
            let doc: Value = serde_json::from_str(&sql(raw)?).map_err(|_| "Повреждённая запись")?;
            for id in validate_document(&doc)? {
                vault.attachment(&id)?;
            }
        }
        drop(stmt);
        drop(vault);
        rename_directory(staging.path(), destination)?;
        Self::open(destination, credential, recovery)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pasted_png_is_encrypted_restored_and_validated() {
        let dir = tempfile::tempdir().unwrap();
        let (mut v, key) = Vault::create(&dir.path().join("v"), "paste test password").unwrap();
        let pixels: Vec<u8> = (0..256 * 256 * 4)
            .map(|i| ((i * 73 + i / 97) % 256) as u8)
            .collect();
        let mut png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png, 256, 256);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .write_header()
                .unwrap()
                .write_image_data(&pixels)
                .unwrap();
        }
        let a = v.add_pasted_image(&png).unwrap();
        assert_eq!(v.read_attachment(&a.id).unwrap(), png);
        assert_ne!(fs::read(v.root.join("files").join(&a.id)).unwrap(), png);
        assert!(v.add_pasted_image(b"not an image").is_err());
        assert!(v.add_pasted_image(&png[..png.len() / 2]).is_err());
        assert!(v.add_pasted_image(&vec![0; 25 * 1024 * 1024 + 1]).is_err());
        let mut e = entry("Вставленное изображение");
        e.document["content"].as_array_mut().unwrap().push(serde_json::json!({"type":"image","attrs":{"attachmentId":a.id,"name":a.name,"mime":a.mime,"size":a.size}}));
        v.save(e).unwrap();
        let mut settings = v.settings().unwrap();
        settings["idleLockMinutes"] = serde_json::json!(0);
        v.set_settings(settings).unwrap();
        let archive = dir.path().join("paste.notbackup");
        v.backup(&archive).unwrap();
        let restored = Vault::restore(&archive, &dir.path().join("restored"), &key, true).unwrap();
        assert_eq!(restored.read_attachment(&a.id).unwrap(), png);
        assert_eq!(crate::idle::minutes(&restored.settings().unwrap()), 0);
    }
    fn entry(text: &str) -> SaveEntry {
        SaveEntry {
            id: Uuid::new_v4().to_string(),
            date: "2026-09-11".into(),
            title: "Личное".into(),
            document: serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]}),
            revision: 0,
        }
    }
    #[test]
    fn search_ten_thousand_entries() {
        let dir = tempfile::tempdir().unwrap();
        let (mut v, _) = Vault::create(&dir.path().join("v"), "long benchmark password").unwrap();
        let tx = v.conn.transaction().unwrap();
        for i in 0..10000 {
            let e = entry(&format!(
                "Запись {i}. События и впечатления. {}",
                "Спокойное утро и прогулка. ".repeat(20)
            ));
            let mut plain = String::new();
            plain_text(&e.document, &mut plain);
            tx.execute("INSERT INTO entries(id,date,title,document,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",params![e.id,e.date,e.title,e.document.to_string(),plain,"2026-09-11T12:00:00Z","2026-09-11T12:00:00Z"]).unwrap();
            tx.execute(
                "INSERT INTO entry_fts(id,title,text) VALUES(?,?,?)",
                params![e.id, e.title, plain],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        let start = std::time::Instant::now();
        let rows = v.list("прогулка", "all", "", 0).unwrap();
        let elapsed = start.elapsed();
        assert_eq!(rows.len(), 60);
        assert!(
            elapsed < Duration::from_millis(300),
            "Search took {elapsed:?}"
        );
        assert_eq!(v.list("9999", "all", "", 0).unwrap().len(), 1);
        println!("10,000 entries, prefix search: {elapsed:?}");
    }
    #[test]
    fn crash_child() {
        let Some(root) = std::env::var_os("NOT_TEST_CRASH_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let (mut v, _) = Vault::create(&root, "long crash test password").unwrap();
        v.save(entry("Подтверждённая запись после сбоя")).unwrap();
        fs::write(root.parent().unwrap().join("ready"), b"saved").unwrap();
        std::thread::sleep(Duration::from_secs(30));
    }
    #[test]
    fn acknowledged_save_survives_killed_process() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("v");
        let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
        cmd.args(["--exact", "vault::tests::crash_child", "--nocapture"])
            .env("NOT_TEST_CRASH_ROOT", &root)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let mut child = cmd.spawn().unwrap();
        let start = std::time::Instant::now();
        while !dir.path().join("ready").exists() && start.elapsed() < Duration::from_secs(15) {
            std::thread::sleep(Duration::from_millis(50));
        }
        let ready = dir.path().join("ready").exists();
        let _ = child.kill();
        child.wait().unwrap();
        assert!(ready, "Child did not acknowledge save");
        let v = Vault::open(&root, "long crash test password", false).unwrap();
        assert_eq!(v.list("Подтверждённая", "all", "", 0).unwrap().len(), 1);
    }
    #[test]
    fn disk_write_failure_keeps_previous_revision() {
        let dir = tempfile::tempdir().unwrap();
        let (mut v, _) = Vault::create(&dir.path().join("v"), "long readonly password").unwrap();
        let e = v.save(entry("Первоначальный текст")).unwrap();
        v.conn.execute_batch("PRAGMA query_only=ON").unwrap();
        let changed = SaveEntry {
            id: e.id.clone(),
            date: e.date,
            title: e.title,
            document: entry("Несохранённый текст").document,
            revision: e.revision,
        };
        assert!(v.save(changed).is_err());
        assert_eq!(v.get(&e.id).unwrap().revision, 1);
    }
    #[test]
    fn encrypted_roundtrip_recovery_backup() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let (mut v, key) = Vault::create(&root, "correct horse battery").unwrap();
        let marker = "СекретныйМаркер🎈";
        let e = v.save(entry(marker)).unwrap();
        assert_eq!(v.list("СекретныйМаркер", "all", "", 0).unwrap().len(), 1);
        let input = dir.path().join("test.txt");
        fs::write(&input, marker).unwrap();
        let a = v.add_attachment(&input).unwrap();
        assert_eq!(v.read_attachment(&a.id).unwrap(), marker.as_bytes());
        let archive = dir.path().join("backup.notbackup");
        v.backup(&archive).unwrap();
        for path in [
            root.join(DB),
            root.join("files").join(&a.id),
            archive.clone(),
        ] {
            let b = fs::read(path).unwrap();
            assert!(!b.windows(marker.len()).any(|w| w == marker.as_bytes()));
        }
        v.change_password("another correct password").unwrap();
        drop(v);
        assert!(Vault::open(&root, "wrong password", false).is_err());
        assert!(Vault::open(&root, "correct horse battery", false).is_err());
        let v = Vault::open(&root, &key, true).unwrap();
        assert_eq!(
            v.get(&e.id)
                .unwrap()
                .document
                .pointer("/content/0/content/0/text")
                .unwrap(),
            marker
        );
        let restored = Vault::restore(&archive, &dir.path().join("restored"), &key, true).unwrap();
        assert_eq!(restored.read_attachment(&a.id).unwrap(), marker.as_bytes());
        assert_eq!(restored.get(&e.id).unwrap().title, "Личное");
    }
    #[test]
    fn stale_saves_and_trash() {
        let dir = tempfile::tempdir().unwrap();
        let (mut v, _) = Vault::create(&dir.path().join("v"), "long test password").unwrap();
        let first = entry("Привет");
        let id = first.id.clone();
        v.save(first).unwrap();
        let mut stale = entry("Поверх");
        stale.id = id.clone();
        assert!(v.save(stale).is_err());
        v.toggle(&id, "deleted", true).unwrap();
        assert!(v.list("", "all", "", 0).unwrap().is_empty());
        assert_eq!(v.list("", "trash", "", 0).unwrap().len(), 1);
        v.toggle(&id, "deleted", false).unwrap();
        assert_eq!(v.list("", "all", "", 0).unwrap().len(), 1);
    }
    #[test]
    fn rejects_remote_images_and_traversal() {
        assert!(valid_id("../vault.json").is_err());
        assert!(validate_document(&serde_json::json!({"type":"doc","content":[{"type":"image","attrs":{"src":"https://evil/image"}}]})).is_err());
        assert!(!safe_link("javascript:alert(1)"));
    }
    #[test]
    fn tampered_stream_fails() {
        crypto::init().unwrap();
        let (_, m, _) = crypto::create("long test password").unwrap();
        let mut encrypted = vec![];
        crypto::encrypt_file(&b"important data"[..], &mut encrypted, &m).unwrap();
        encrypted.pop();
        assert!(crypto::decrypt_file(&encrypted[..], std::io::sink(), &m).is_err());
    }
    #[test]
    fn large_attachment_roundtrip_export_backup_and_legacy_detection() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        let (v, key) = Vault::create(&root, "large attachment password").unwrap();
        let source: Vec<u8> = (0..280_000).map(|i| (i % 251) as u8).collect();
        let input = dir.path().join("large.bin");
        fs::write(&input, &source).unwrap();
        let a = v.add_attachment(&input).unwrap();
        assert!(v.read_attachment(&a.id).unwrap() == source);
        let output = dir.path().join("export.bin");
        v.write_attachment(&a.id, &output).unwrap();
        assert!(fs::read(&output).unwrap() == source);
        let archive = dir.path().join("backup.notbackup");
        v.backup(&archive).unwrap();
        let restored = Vault::restore(&archive, &dir.path().join("restored"), &key, true).unwrap();
        assert!(restored.read_attachment(&a.id).unwrap() == source);
        // Old v0.1.0 authenticated only the first chunk, despite larger metadata.
        let mut legacy = Vec::new();
        crypto::encrypt_file(&source[..65536], &mut legacy, &v.master).unwrap();
        fs::write(root.join("files").join(&a.id), legacy).unwrap();
        assert_eq!(v.read_attachment(&a.id).unwrap_err(), INCOMPLETE_ATTACHMENT);
        assert_eq!(
            v.write_attachment(&a.id, &output).unwrap_err(),
            INCOMPLETE_ATTACHMENT
        );
        assert!(
            fs::read(output).unwrap() == source,
            "failed export must preserve existing file"
        );
    }
    #[test]
    fn image_layout_is_validated_and_exported() {
        let dir = tempfile::tempdir().unwrap();
        let (mut v, _) = Vault::create(&dir.path().join("vault"), "image layout password").unwrap();
        let source = dir.path().join("image.png");
        fs::write(&source, b"\x89PNG\r\n\x1a\nsynthetic export test").unwrap();
        let a = v.add_attachment(&source).unwrap();
        let mut e = entry("Текст рядом");
        let image = serde_json::json!({"type":"image","attrs":{"attachmentId":a.id,"widthPercent":42,"layout":"right"}});
        e.document["content"]
            .as_array_mut()
            .unwrap()
            .insert(0, image);
        let mut bad = e.document.clone();
        bad["content"][0]["attrs"]["widthPercent"] = serde_json::json!(101);
        assert!(validate_document(&bad).is_err());
        bad = e.document.clone();
        bad["content"][0]["attrs"]["layout"] = serde_json::json!("right;position:fixed");
        assert!(validate_document(&bad).is_err());
        let saved = v.save(e).unwrap();
        assert_eq!(
            v.get(&saved.id).unwrap().document["content"][0]["attrs"]["widthPercent"],
            42
        );
        let export = crate::export::export(&v, &saved.id, dir.path()).unwrap();
        let html = fs::read_to_string(PathBuf::from(export).join("index.html")).unwrap();
        assert!(html.contains("journal-image right\" style=\"width:42%"));
        assert!(html.contains("Текст рядом"));
    }
    #[test]
    fn backup_validation_rejects_corruption_and_paths() {
        let dir = tempfile::tempdir().unwrap();
        let (v, key) = Vault::create(&dir.path().join("vault"), "archive test password").unwrap();
        let archive = dir.path().join("valid.notbackup");
        v.backup(&archive).unwrap();
        assert!(Vault::restore(&archive, &dir.path().join("wrong"), "wrong", false).is_err());
        assert!(!dir.path().join("wrong").exists());
        let truncated = dir.path().join("truncated.notbackup");
        let mut bytes = fs::read(&archive).unwrap();
        bytes.truncate(bytes.len() / 2);
        fs::write(&truncated, bytes).unwrap();
        assert!(Vault::restore(&truncated, &dir.path().join("broken"), &key, true).is_err());
        assert!(!dir.path().join("broken").exists());
        let malicious = dir.path().join("path.notbackup");
        let mut zip = zip::ZipWriter::new(File::create(&malicious).unwrap());
        zip.start_file("../escaped.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"must remain inside archive").unwrap();
        zip.finish().unwrap();
        assert!(Vault::restore(&malicious, &dir.path().join("bad"), &key, true).is_err());
        assert!(!dir.path().join("escaped.txt").exists());
        assert!(!dir.path().join("bad").exists());
    }
    #[test]
    fn html_export_preserves_content_and_attachments_without_injection() {
        let dir = tempfile::tempdir().unwrap();
        let (mut v, _) = Vault::create(&dir.path().join("vault"), "export test password").unwrap();
        let source = dir.path().join("note.txt");
        fs::write(&source, "Приложенный текст 🎈").unwrap();
        let a = v.add_attachment(&source).unwrap();
        let mut e = entry("<script>alert('test')</script> & текст");
        e.title = "<img src=x onerror=alert(1)>".into();
        e.document["content"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "type":"attachment","attrs":{"attachmentId":a.id,"name":a.name}
            }));
        let e = v.save(e).unwrap();
        let out = PathBuf::from(crate::export::export(&v, &e.id, dir.path()).unwrap());
        let html = fs::read_to_string(out.join("index.html")).unwrap();
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("&lt;img src=x"));
        assert!(!html.contains("<script>"));
        assert!(!html.contains("<img src=x"));
        assert!(html.contains("Content-Security-Policy"));
        assert_eq!(
            fs::read_to_string(out.join("assets").join(format!("{}.bin", a.id))).unwrap(),
            "Приложенный текст 🎈"
        );
    }

    #[test]
    fn highlight_roundtrip_backup_export_and_invalid_color() {
        crypto::init().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let (mut v, recovery) =
            Vault::create(&dir.path().join("vault"), "highlight test password").unwrap();
        for color in ["lavender", "yellow", "green", "pink"] {
            let mut input = entry("Важная мысль 🎈");
            input.document["content"][0]["content"][0]["marks"] = serde_json::json!([
                {"type":"bold"}, {"type":"highlight","attrs":{"color":color}}
            ]);
            let saved = v.save(input).unwrap();
            assert_eq!(v.get(&saved.id).unwrap().document, saved.document);
            let archive = dir.path().join(format!("{color}.notbackup"));
            v.backup(&archive).unwrap();
            let restored = Vault::restore(
                &archive,
                &dir.path().join(format!("restored-{color}")),
                &recovery,
                true,
            )
            .unwrap();
            let output =
                PathBuf::from(crate::export::export(&restored, &saved.id, dir.path()).unwrap());
            let html = fs::read_to_string(output.join("index.html")).unwrap();
            assert!(html.contains(&format!("data-highlight=\"{color}\"")));
            assert!(html.contains("<strong>Важная мысль 🎈</strong>"));
        }
        for color in [
            "red",
            "url(https://example.com)",
            "\" onmouseover=\"alert(1)",
            "",
        ] {
            let mut input = entry("Invalid marker");
            input.document["content"][0]["content"][0]["marks"] = serde_json::json!([
                {"type":"highlight","attrs":{"color":color}}
            ]);
            assert!(v.save(input).is_err());
        }
    }
}
