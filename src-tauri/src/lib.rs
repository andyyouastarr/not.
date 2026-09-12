mod crypto;
mod export;
mod session;
mod vault;
use crypto::Result;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroize;

struct State {
    root: PathBuf,
    vault: Option<vault::Vault>,
    activity: Instant,
    locking: Option<Instant>,
}
type Shared = Arc<Mutex<State>>;
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Status,
    Create {
        password: String,
    },
    Unlock {
        credential: String,
        recovery: bool,
    },
    ConfirmRecovery {
        key: String,
    },
    PendingRecovery,
    Lock,
    Touch,
    List {
        query: String,
        filter: String,
        date: String,
        offset: u32,
    },
    Get {
        id: String,
    },
    Save {
        entry: vault::SaveEntry,
    },
    Toggle {
        id: String,
        field: String,
        value: bool,
    },
    Settings,
    SetSettings {
        value: Value,
    },
    ChangePassword {
        password: String,
    },
    AddAttachment,
    ReadAttachment {
        id: String,
    },
    SaveAttachment {
        id: String,
    },
    Backup,
    DailyBackup,
    Restore {
        credential: String,
        recovery: bool,
    },
    Export {
        id: String,
    },
    Close,
}
fn pick_path(p: tauri_plugin_dialog::FilePath) -> Result<PathBuf> {
    p.into_path()
        .map_err(|_| "Выберите локальную папку или файл".into())
}
#[tauri::command]
async fn dispatch(
    request: Request,
    app: tauri::AppHandle,
    state: tauri::State<'_, Shared>,
) -> Result<Value> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || handle(request, app, state))
        .await
        .map_err(|_| "Операция прервана")?
}
fn handle(request: Request, app: tauri::AppHandle, state: Shared) -> Result<Value> {
    // Native dialogs are opened outside the vault mutex: system lock must remain responsive.
    let selected = match &request {
        Request::AddAttachment => {
            #[cfg(debug_assertions)]
            if std::env::var_os("NOT_STUDIO_TEST_DATA_DIR").is_some() {
                if let Some(path) = std::env::var_os("NOT_STUDIO_TEST_ATTACHMENT") {
                    let s = state.lock().map_err(|_| "Хранилище недоступно")?;
                    return Ok(json!(s
                        .vault
                        .as_ref()
                        .ok_or("Дневник заблокирован")?
                        .add_attachment(&PathBuf::from(path))?));
                }
            }
            app.dialog()
                .file()
                .set_title("Добавить фото или файл · до 25 МБ")
                .blocking_pick_file()
        }
        Request::Backup => app
            .dialog()
            .file()
            .set_title("Зашифрованная резервная копия")
            .set_file_name(format!(
                "not-{}.notbackup",
                chrono::Local::now().format("%Y-%m-%d")
            ))
            .add_filter("Копия not.", &["notbackup"])
            .blocking_save_file(),
        Request::Restore { .. } => app
            .dialog()
            .file()
            .set_title("Восстановить зашифрованную копию")
            .add_filter("Копия not.", &["notbackup"])
            .blocking_pick_file(),
        Request::Export { .. } => app
            .dialog()
            .file()
            .set_title("Папка для открытого HTML и вложений")
            .blocking_pick_folder(),
        Request::SaveAttachment { id } => {
            let name = {
                let s = state.lock().map_err(|_| "Хранилище недоступно")?;
                s.vault
                    .as_ref()
                    .ok_or("Дневник заблокирован")?
                    .attachment(id)?
                    .name
            };
            app.dialog()
                .file()
                .set_title("Сохранить расшифрованное вложение")
                .set_file_name(name)
                .blocking_save_file()
        }
        _ => None,
    };
    if matches!(
        &request,
        Request::AddAttachment
            | Request::Backup
            | Request::Restore { .. }
            | Request::Export { .. }
            | Request::SaveAttachment { .. }
    ) && selected.is_none()
    {
        return Ok(Value::Null);
    }
    let selected = selected.map(pick_path).transpose()?;
    let mut s = state.lock().map_err(|_| "Хранилище недоступно")?;
    match request {
        Request::Status => {
            return Ok(json!({"exists":s.root.exists(),"unlocked":s.vault.is_some()}))
        }
        Request::Create { mut password } => {
            let result = vault::Vault::create(&s.root, &password);
            password.zeroize();
            let (v, key) = result?;
            s.vault = Some(v);
            s.activity = Instant::now();
            s.locking = None;
            return Ok(json!({"recoveryKey":key}));
        }
        Request::Unlock {
            mut credential,
            recovery,
        } => {
            let result = vault::Vault::open(&s.root, &credential, recovery);
            credential.zeroize();
            s.vault = Some(result?);
            s.activity = Instant::now();
            s.locking = None;
            return Ok(json!(true));
        }
        Request::Lock => {
            s.vault = None;
            s.locking = None;
            let _ = app.emit("vault-locked", ());
            return Ok(json!(true));
        }
        Request::Touch => {
            s.activity = Instant::now();
            return Ok(json!(true));
        }
        Request::Close => {
            s.vault = None;
            drop(s);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.destroy();
            }
            return Ok(json!(true));
        }
        Request::Restore {
            mut credential,
            recovery,
        } => {
            let candidate = s
                .root
                .parent()
                .unwrap()
                .join(format!("restore-{}", uuid::Uuid::new_v4()));
            let result =
                vault::Vault::restore(&selected.unwrap(), &candidate, &credential, recovery);
            credential.zeroize();
            let v = result?;
            drop(v);
            s.vault = None;
            s.locking = None;
            // The connection must close before directory replacement on Windows.
            // Clear the UI even if the subsequent filesystem operation fails.
            let _ = app.emit("vault-locked", ());
            let original = s.root.parent().unwrap().join(format!(
                "previous-{}",
                chrono::Utc::now().timestamp_millis()
            ));
            if s.root.exists() {
                vault::rename_directory(&s.root, &original)
                    .map_err(|_| "Не удалось отложить текущее хранилище")?;
            }
            if vault::rename_directory(&candidate, &s.root).is_err() {
                if original.exists() {
                    let _ = vault::rename_directory(&original, &s.root);
                }
                return Err(
                    "Не удалось завершить восстановление. Исходное хранилище сохранено.".into(),
                );
            }
            return Ok(json!(true));
        }
        _ => {}
    }
    let v = s.vault.as_mut().ok_or("Дневник заблокирован")?;
    match request {
        Request::ConfirmRecovery { mut key } => {
            let result = crypto::unlock(&v.manifest, &key, true);
            key.zeroize();
            result?;
            v.clear_pending_recovery()?;
            let mut p = v.settings()?;
            p["recoveryConfirmed"] = json!(true);
            v.set_settings(p)?;
            Ok(json!(true))
        }
        Request::PendingRecovery => Ok(json!(v.pending_recovery()?)),
        Request::List {
            query,
            filter,
            date,
            offset,
        } => Ok(json!(v.list(&query, &filter, &date, offset)?)),
        Request::Get { id } => Ok(json!(v.get(&id)?)),
        Request::Save { entry } => Ok(json!(v.save(entry)?)),
        Request::Toggle { id, field, value } => {
            v.toggle(&id, &field, value)?;
            Ok(json!(true))
        }
        Request::Settings => v.settings(),
        Request::SetSettings { value } => {
            let object = value.as_object().ok_or("Неверные настройки")?;
            if object
                .keys()
                .any(|k| !["opaque", "lastEntry", "recoveryConfirmed"].contains(&k.as_str()))
                || !value["opaque"].is_boolean()
            {
                return Err("Неверные настройки".into());
            }
            if let Some(id) = value["lastEntry"].as_str() {
                vault::valid_id(id)?;
            } else if !value["lastEntry"].is_null() {
                return Err("Неверные настройки".into());
            }
            let mut value = value;
            value["recoveryConfirmed"] = v.settings()?["recoveryConfirmed"].clone();
            v.set_settings(value)?;
            Ok(json!(true))
        }
        Request::ChangePassword { mut password } => {
            let result = v.change_password(&password);
            password.zeroize();
            result?;
            Ok(json!(true))
        }
        Request::AddAttachment => Ok(json!(v.add_attachment(&selected.unwrap())?)),
        Request::ReadAttachment { id } => {
            use base64::Engine;
            let a = v.attachment(&id)?;
            if !a.mime.starts_with("image/") {
                return Err("Предпросмотр доступен только для изображений".into());
            }
            let mut bytes = v.read_attachment(&id)?;
            let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
            bytes.zeroize();
            Ok(json!({"data":data,"mime":a.mime}))
        }
        Request::SaveAttachment { id } => {
            v.write_attachment(&id, &selected.unwrap())?;
            Ok(json!(true))
        }
        Request::Backup => {
            v.backup(&selected.unwrap())?;
            Ok(json!(true))
        }
        Request::DailyBackup => {
            v.daily_backup()?;
            Ok(json!(true))
        }
        Request::Export { id } => Ok(json!(export::export(v, &id, &selected.unwrap())?)),
        _ => Err("Неизвестная операция".into()),
    }
}
pub fn run() {
    #[cfg(debug_assertions)]
    eprintln!("not: starting native runtime");
    let context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    let context = {
        let mut context = context;
        if std::env::var_os("NOT_STUDIO_TEST_DATA_DIR").is_some() {
            for window in &mut context.config_mut().app.windows {
                window.create = false;
            }
        }
        context
    };
    let builder = tauri::Builder::default();
    let isolated_test =
        cfg!(debug_assertions) && std::env::var_os("NOT_STUDIO_TEST_DATA_DIR").is_some();
    let builder = if isolated_test {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
    };
    builder
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(debug_assertions)]
            eprintln!("not: setup entered");
            crypto::init().map_err(std::io::Error::other)?;
            let data = app.path().app_data_dir()?;
            #[cfg(debug_assertions)]
            let data = std::env::var_os("NOT_STUDIO_TEST_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or(data);
            std::fs::create_dir_all(&data)?;
            let shared: Shared = Arc::new(Mutex::new(State {
                root: data.join("vault"),
                vault: None,
                activity: Instant::now(),
                locking: None,
            }));
            app.manage(shared.clone());
            #[cfg(debug_assertions)]
            if let Some(test_dir) = std::env::var_os("NOT_STUDIO_TEST_DATA_DIR") {
                tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                    .devtools(true)
                    .additional_browser_args("--remote-debugging-port=0")
                    .data_directory(PathBuf::from(test_dir).join("webview"))
                    .build()?;
            }
            #[cfg(debug_assertions)]
            eprintln!("not: vault service ready");
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(1));
                let Ok(mut s) = shared.try_lock() else {
                    continue;
                };
                if s.vault.is_none() {
                    continue;
                }
                if s.locking
                    .is_some_and(|t| t.elapsed() > Duration::from_secs(3))
                {
                    s.vault = None;
                    s.locking = None;
                    let _ = handle.emit("vault-locked", ());
                    continue;
                }
                if s.locking.is_none()
                    && (s.activity.elapsed() > Duration::from_secs(300) || session::locked())
                {
                    s.locking = Some(Instant::now());
                    let _ = handle.emit("vault-lock-request", ());
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Some(state) = window.try_state::<Shared>() {
                    if let Ok(state) = state.try_lock() {
                        if state.vault.is_none() {
                            return;
                        }
                    }
                }
                api.prevent_close();
                let _ = window.emit("close-request", ());
            }
        })
        .invoke_handler(tauri::generate_handler![dispatch])
        .run(context)
        .expect("Не удалось запустить not. studio");
}
