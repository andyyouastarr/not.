use crate::crypto::Result;
use serde_json::{json, Value};

// Read only after an explicit paste gesture. Never watch or log clipboard contents.
#[cfg(windows)]
pub fn image_files() -> Result<Vec<Value>> {
    use base64::Engine;
    use std::{io::Read, os::windows::ffi::OsStringExt, path::PathBuf};
    use windows_sys::Win32::{
        System::DataExchange::{
            CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
        },
        UI::Shell::DragQueryFileW,
    };
    let paths = unsafe {
        const CF_HDROP: u32 = 15;
        if IsClipboardFormatAvailable(CF_HDROP) == 0 {
            return Ok(vec![]);
        }
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("Буфер обмена занят. Повторите вставку.".into());
        }
        struct Close;
        impl Drop for Close {
            fn drop(&mut self) {
                unsafe {
                    CloseClipboard();
                }
            }
        }
        let _close = Close;
        let handle = GetClipboardData(CF_HDROP);
        if handle.is_null() {
            return Err("Не удалось прочитать буфер обмена".into());
        }
        let count = DragQueryFileW(handle, u32::MAX, std::ptr::null_mut(), 0);
        if count > 8 {
            return Err("Вставляйте не больше 8 изображений за раз".into());
        }
        let mut paths = Vec::new();
        for index in 0..count {
            let len = DragQueryFileW(handle, index, std::ptr::null_mut(), 0);
            if len > 32767 {
                return Err("Слишком длинный путь к изображению".into());
            }
            let mut wide = vec![0; len as usize + 1];
            DragQueryFileW(handle, index, wide.as_mut_ptr(), len + 1);
            paths.push(PathBuf::from(std::ffi::OsString::from_wide(
                &wide[..len as usize],
            )));
        }
        paths
    };
    let mut results = Vec::new();
    let mut total = 0;
    for path in paths {
        let file =
            std::fs::File::open(path).map_err(|_| "Не удалось прочитать скопированный файл")?;
        let mut bytes = zeroize::Zeroizing::new(Vec::new());
        file.take(25 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Не удалось прочитать изображение")?;
        total += bytes.len();
        if total > 25 * 1024 * 1024 {
            return Err("За одну вставку можно добавить не больше 25 МБ".into());
        }
        let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            "image/png"
        } else if bytes.starts_with(&[255, 216, 255]) {
            "image/jpeg"
        } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            "image/gif"
        } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            "image/webp"
        } else {
            return Err(
                "Скопируйте PNG, JPEG, GIF или WebP. Другие файлы добавьте через «Фото или файл»."
                    .into(),
            );
        };
        results.push(
            json!({"mime":mime,"data":base64::engine::general_purpose::STANDARD.encode(&bytes)}),
        );
    }
    Ok(results)
}
#[cfg(not(windows))]
pub fn image_files() -> Result<Vec<Value>> {
    Ok(vec![])
}
