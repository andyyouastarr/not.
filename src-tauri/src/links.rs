use crate::crypto::Result;

fn validate(value: &str) -> Result<tauri::Url> {
    let href = value.trim();
    if href.len() > 8192 || href.chars().any(char::is_control) {
        return Err("Некорректный адрес ссылки".into());
    }
    let url = tauri::Url::parse(href).map_err(|_| "Некорректный адрес ссылки")?;
    match url.scheme() {
        "http" | "https" if url.host_str().is_some() => Ok(url),
        "mailto" if !url.path().is_empty() => Ok(url),
        _ => Err("Разрешены только ссылки http://, https:// и mailto:".into()),
    }
}

pub fn open(app: &tauri::AppHandle, value: &str) -> Result<()> {
    let url = validate(value)?;
    #[cfg(windows)]
    {
        // Use Tauri's COM-initialized UI thread. No cmd.exe or command-line interpolation.
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            use windows_sys::Win32::UI::{
                Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL,
            };
            let href: Vec<u16> = url.as_str().encode_utf16().chain(Some(0)).collect();
            let verb: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
            let code = unsafe {
                ShellExecuteW(
                    std::ptr::null_mut(),
                    verb.as_ptr(),
                    href.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null(),
                    SW_SHOWNORMAL,
                )
            } as isize;
            let _ = tx.send(code > 32);
        })
        .map_err(|_| "Не удалось открыть ссылку")?;
        if !rx.recv().map_err(|_| "Не удалось открыть ссылку")? {
            return Err(
                "Не удалось открыть ссылку. Проверьте приложение по умолчанию в Windows.".into(),
            );
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, url);
        Err("Открытие ссылок поддерживается в сборке для Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_external_urls_before_system_open() {
        for valid in [
            "https://example.org/path?a=1&b=2#part",
            "http://127.0.0.1:12345/check",
            "mailto:test@example.org?subject=Hello",
            "https://пример.рф/страница",
        ] {
            assert!(validate(valid).is_ok());
        }
        for invalid in [
            "javascript:alert(1)",
            "file:///C:/Windows/notepad.exe",
            "C:\\Windows\\notepad.exe",
            "\\\\server\\share",
            "data:text/html,test",
            "ms-settings:privacy",
            "https://",
            "mailto:",
            "https://example.org/\0test",
            "https://exam\nple.org",
            "",
        ] {
            assert!(validate(invalid).is_err());
        }
        assert!(validate(&format!("https://example.org/{}", "a".repeat(8192))).is_err());
    }
}
