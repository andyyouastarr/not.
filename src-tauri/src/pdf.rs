//! Native PDF adapter. Paths stay in Rust; printing never holds the vault mutex.
use crate::{crypto::Result, Shared};
use std::{io::Write, path::PathBuf, time::Duration};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;

pub struct Operation {
    id: String,
    path: Option<PathBuf>,
    printing: bool,
}

fn filename(name: &str) -> String {
    let clean: String = name
        .chars()
        .take(120)
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let clean = clean.trim().trim_end_matches(['.', ' ']);
    let clean = clean.strip_suffix(".pdf").unwrap_or(clean);
    // Prefix Windows device names, including names with extensions.
    let stem = clean.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    format!(
        "{}{}.pdf",
        if reserved { "_" } else { "" },
        if clean.is_empty() {
            "Документ"
        } else {
            clean
        }
    )
}

pub fn begin(app: &tauri::AppHandle, shared: &Shared, name: &str) -> Result<Option<String>> {
    let id = uuid::Uuid::new_v4().to_string();
    {
        let mut state = shared.lock().map_err(|_| "Хранилище недоступно")?;
        if state.vault.is_none() || state.locking.is_some() {
            return Err("Дневник заблокирован".into());
        }
        if state.pdf.is_some() {
            return Err("Экспорт PDF уже выполняется".into());
        }
        state.pdf = Some(Operation {
            id: id.clone(),
            path: None,
            printing: false,
        });
    }
    let selected = choose_path(app, name);
    let mut state = shared.lock().map_err(|_| "Хранилище недоступно")?;
    let op = state
        .pdf
        .as_mut()
        .filter(|op| op.id == id)
        .ok_or("Экспорт PDF отменён")?;
    match selected {
        Ok(Some(mut path)) => {
            if !path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
            {
                path.set_extension("pdf");
            }
            op.path = Some(path);
            Ok(Some(id))
        }
        Ok(None) => {
            state.pdf = None;
            Ok(None)
        }
        Err(error) => {
            state.pdf = None;
            Err(error)
        }
    }
}

fn choose_path(app: &tauri::AppHandle, name: &str) -> Result<Option<PathBuf>> {
    #[cfg(debug_assertions)]
    if std::env::var_os("NOT_STUDIO_TEST_DATA_DIR").is_some() {
        if let Some(path) = std::env::var_os("NOT_STUDIO_TEST_PDF") {
            return Ok(Some(path.into()));
        }
    }
    app.dialog()
        .file()
        .set_title("Сохранить PDF")
        .set_file_name(filename(name))
        .add_filter("PDF", &["pdf"])
        .blocking_save_file()
        .map(crate::pick_path)
        .transpose()
}

pub fn cancel(shared: &Shared, id: &str) -> Result<()> {
    let mut state = shared.lock().map_err(|_| "Хранилище недоступно")?;
    if state.pdf.as_ref().is_some_and(|op| op.id == id) {
        state.pdf = None;
    }
    Ok(())
}

pub fn print(app: &tauri::AppHandle, shared: &Shared, id: &str) -> Result<()> {
    let path = {
        let mut state = shared.lock().map_err(|_| "Хранилище недоступно")?;
        if state.vault.is_none() || state.locking.is_some() {
            return Err("Экспорт PDF отменён".into());
        }
        let op = state
            .pdf
            .as_mut()
            .filter(|op| op.id == id && !op.printing)
            .ok_or("Экспорт PDF недоступен")?;
        let path = op.path.clone().ok_or("Путь PDF не выбран")?;
        op.printing = true;
        path
    };
    let result = (|| {
        let window = app
            .get_webview_window("main")
            .ok_or("Окно приложения недоступно")?;
        let bytes = native_print(&window)?;
        validate_pdf(&bytes)?;
        // Write and sync outside the vault mutex. Only the final atomic rename
        // is serialized with lock, preventing a late callback from publishing.
        let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or("Неверный путь PDF")?)
            .map_err(|_| "Не удалось создать PDF в выбранной папке")?;
        temp.write_all(&bytes)
            .map_err(|_| "Не удалось записать PDF")?;
        temp.as_file()
            .sync_all()
            .map_err(|_| "Не удалось сохранить PDF на диск")?;
        let state = shared.lock().map_err(|_| "Хранилище недоступно")?;
        if state.vault.is_none()
            || state.locking.is_some()
            || state.pdf.as_ref().is_none_or(|op| op.id != id)
        {
            return Err("Экспорт PDF отменён".into());
        }
        temp.persist(&path)
            .map_err(|_| "Не удалось завершить запись PDF; исходный файл сохранён")?;
        Ok(())
    })();
    let _ = cancel(shared, id);
    result
}

// Chromium emits plain page dictionaries even when content streams are compressed.
// This is a bounded structural sanity check, not a full PDF conformance parser.
fn validate_pdf(bytes: &[u8]) -> Result<()> {
    if !bytes.starts_with(b"%PDF-") || !bytes.windows(5).rev().take(1024).any(|x| x == b"%%EOF") {
        return Err("WebView2 вернул неполный PDF".into());
    }
    let text = String::from_utf8_lossy(bytes);
    let mut pages = 0;
    for tail in text.split("/MediaBox").skip(1) {
        let Some(end) = tail.find(']') else {
            return Err("Неверный размер страницы PDF".into());
        };
        let values: Vec<f64> = tail[..end]
            .trim()
            .trim_start_matches('[')
            .split_whitespace()
            .filter_map(|v| v.parse().ok())
            .collect();
        if values.len() != 4
            || (values[2] - values[0] - 595.276).abs() > 2.0
            || (values[3] - values[1] - 841.89).abs() > 2.0
        {
            return Err("PDF должен содержать страницы A4".into());
        }
        pages += 1;
    }
    if pages == 0 {
        return Err("PDF не содержит страниц A4".into());
    }
    Ok(())
}

#[cfg(windows)]
fn native_print(window: &tauri::WebviewWindow) -> Result<Zeroizing<Vec<u8>>> {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    use webview2_com::{Microsoft::Web::WebView2::Win32::*, PrintToPdfStreamCompletedHandler};
    use windows::core::Interface;
    static PRINTING: AtomicBool = AtomicBool::new(false);
    if PRINTING.swap(true, Ordering::SeqCst) {
        return Err("WebView2 ещё завершает предыдущую печать".into());
    }
    let (tx, rx) = mpsc::channel();
    let scheduled = window.with_webview(move |webview| unsafe {
        let fail = tx.clone();
        let background_controller = webview.controller().cast::<ICoreWebView2Controller2>();
        let mut previous_background = COREWEBVIEW2_COLOR::default();
        if let Ok(controller) = &background_controller {
            let _ = controller.DefaultBackgroundColor(&mut previous_background);
        }
        let start = || -> windows::core::Result<()> {
            let core: ICoreWebView2_16 = webview.controller().CoreWebView2()?.cast()?;
            let env: ICoreWebView2Environment6 = webview.environment().cast()?;
            let settings = env.CreatePrintSettings()?;
            settings.SetPageWidth(210.0 / 25.4)?;
            settings.SetPageHeight(297.0 / 25.4)?;
            settings.SetMarginTop(18.0 / 25.4)?;
            settings.SetMarginBottom(18.0 / 25.4)?;
            settings.SetMarginLeft(18.0 / 25.4)?;
            settings.SetMarginRight(18.0 / 25.4)?;
            settings.SetScaleFactor(1.0)?;
            settings.SetShouldPrintBackgrounds(true)?;
            settings.SetShouldPrintHeaderAndFooter(false)?;
            // WebView2 uses its controller background for paper margins, unlike
            // Chromium headless. Change only the backing color, never app theme.
            let controller = background_controller.as_ref().map_err(Clone::clone)?;
            controller.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                A: 255,
                R: 255,
                G: 255,
                B: 255,
            })?;
            let restore_controller = controller.clone();
            core.PrintToPdfStream(
                &settings,
                &PrintToPdfStreamCompletedHandler::create(Box::new(move |status, stream| {
                    let _ = restore_controller.SetDefaultBackgroundColor(previous_background);
                    let result = (|| -> Result<Zeroizing<Vec<u8>>> {
                        status.map_err(|_| "Не удалось сформировать PDF")?;
                        let stream = stream.ok_or("WebView2 не вернул PDF")?;
                        let mut bytes = Zeroizing::new(Vec::new());
                        let mut chunk = Zeroizing::new(vec![0u8; 65536]);
                        loop {
                            let mut read = 0;
                            stream
                                .Read(
                                    chunk.as_mut_ptr().cast(),
                                    chunk.len() as u32,
                                    Some(&mut read),
                                )
                                .ok()
                                .map_err(|_| "Не удалось прочитать PDF")?;
                            if read == 0 {
                                break;
                            }
                            if bytes.len() + read as usize > 128 * 1024 * 1024 {
                                return Err("PDF превышает допустимый размер 128 МБ".into());
                            }
                            bytes.extend_from_slice(&chunk[..read as usize]);
                        }
                        Ok(bytes)
                    })();
                    PRINTING.store(false, Ordering::SeqCst);
                    let _ = tx.send(result);
                    Ok(())
                })),
            )
        };
        if start().is_err() {
            if let Ok(controller) = background_controller {
                let _ = controller.SetDefaultBackgroundColor(previous_background);
            }
            PRINTING.store(false, Ordering::SeqCst);
            let _ = fail.send(Err("Печать PDF недоступна в установленном WebView2".into()));
        }
    });
    if scheduled.is_err() {
        PRINTING.store(false, Ordering::SeqCst);
        return Err("Не удалось запустить печать PDF".into());
    }
    rx.recv_timeout(Duration::from_secs(60))
        .map_err(|_| "Превышено время формирования PDF")?
}

#[cfg(not(windows))]
fn native_print(_: &tauri::WebviewWindow) -> Result<Zeroizing<Vec<u8>>> {
    Err("Экспорт PDF доступен в Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filenames_and_pdf_validation() {
        assert_eq!(filename("CON"), "_CON.pdf");
        assert_eq!(filename("  Тест / запись?  "), "Тест _ запись_.pdf");
        assert_eq!(filename("..."), "Документ.pdf");
        assert_eq!(filename("note.pdf"), "note.pdf");
        assert!(validate_pdf(b"%PDF-1.7\n/MediaBox [0 0 595.28 841.89]\n%%EOF").is_ok());
        assert!(validate_pdf(b"%PDF-1.7\n/MediaBox [0 0 612 792]\n%%EOF").is_err());
        assert!(validate_pdf(b"%PDF-1.7\n%%EOF").is_err());
        assert!(validate_pdf(b"%PDF-1.7\n/MediaBox [0 0 595.28 841.89]").is_err());
    }
}
