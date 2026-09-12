#[cfg(windows)]
pub fn locked() -> bool {
    use windows_sys::Win32::System::RemoteDesktop::*;
    unsafe {
        let mut ptr = std::ptr::null_mut();
        let mut bytes = 0;
        if WTSQuerySessionInformationW(
            WTS_CURRENT_SERVER_HANDLE,
            WTS_CURRENT_SESSION,
            WTSSessionInfoEx,
            &mut ptr,
            &mut bytes,
        ) == 0
        {
            return false;
        }
        let locked = if bytes as usize >= std::mem::size_of::<WTSINFOEXW>() {
            let info = &*(ptr as *const WTSINFOEXW);
            info.Level == 1
                && info.Data.WTSInfoExLevel1.SessionFlags == WTS_SESSIONSTATE_LOCK as i32
        } else {
            false
        };
        WTSFreeMemory(ptr as *mut _);
        locked
    }
}
#[cfg(not(windows))]
pub fn locked() -> bool {
    false
}
