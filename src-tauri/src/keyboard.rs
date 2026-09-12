use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardState {
    layout: &'static str,
    id: String,
    caps_lock: bool,
}

// Match complete handles, not just the language: US Dvorak and Russian
// typewriter must never be presented as QWERTY and standard Russian.
fn layout_name(id: u32) -> &'static str {
    match id {
        0x04090409 | 0x00000409 => "en-US",
        0x04190419 | 0x00000419 => "ru-RU",
        _ => "unsupported",
    }
}

#[cfg(windows)]
fn read(window: &tauri::WebviewWindow) -> Option<KeyboardState> {
    use windows_sys::Win32::UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*};
    let hwnd = window.hwnd().ok()?.0;
    unsafe {
        // Only inspect our active window. WebView2 can own the focused child
        // on a different input thread from the Tauri top-level window.
        if GetForegroundWindow() != hwnd {
            return None;
        }
        let mut info: GUITHREADINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
        if GetGUIThreadInfo(0, &mut info) == 0 || info.hwndFocus.is_null() {
            return None;
        }
        let thread = GetWindowThreadProcessId(info.hwndFocus, std::ptr::null_mut());
        if thread == 0 {
            return None;
        }
        let id = GetKeyboardLayout(thread) as usize as u32;
        if id == 0 {
            return None;
        }
        Some(KeyboardState {
            layout: layout_name(id),
            id: format!("{id:08X}"),
            caps_lock: GetKeyState(VK_CAPITAL as i32) & 1 != 0,
        })
    }
}

#[cfg(not(windows))]
fn read(_window: &tauri::WebviewWindow) -> Option<KeyboardState> {
    None
}

// Read outside the vault mutex, on the UI thread (GetKeyState is queue based).
// No key hooks, input simulation or recording of typed characters.
#[tauri::command]
pub async fn keyboard_state(window: tauri::WebviewWindow) -> Result<Option<KeyboardState>, String> {
    let (tx, rx) = tauri::async_runtime::channel(1);
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = tx.try_send(read(&target));
        })
        .map_err(|_| "Keyboard state unavailable".to_string())?;
    let mut rx = rx;
    rx.recv()
        .await
        .ok_or_else(|| "Keyboard state unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distinguishes_layout_variants() {
        assert_eq!(layout_name(0x04090409), "en-US");
        assert_eq!(layout_name(0x04190419), "ru-RU");
        for id in [0x08090809, 0xf0020409, 0xf0020419, 0, 0x04070407] {
            assert_eq!(layout_name(id), "unsupported");
        }
    }
}
