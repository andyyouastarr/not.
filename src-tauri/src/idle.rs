use serde_json::Value;
use std::time::Duration;

pub const DEFAULT_MINUTES: u64 = 30;
pub fn minutes(settings: &Value) -> u64 {
    settings["idleLockMinutes"]
        .as_u64()
        .filter(|n| *n <= 240)
        .unwrap_or(DEFAULT_MINUTES)
}
pub fn due(minutes: u64, elapsed: Duration, windows_locked: bool) -> bool {
    windows_locked || (minutes != 0 && elapsed >= Duration::from_secs(minutes * 60))
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn default_disabled_and_windows_lock() {
        assert_eq!(minutes(&json!({})), 30);
        assert_eq!(minutes(&json!({"idleLockMinutes":0})), 0);
        assert!(!due(30, Duration::from_secs(1799), false));
        assert!(due(30, Duration::from_secs(1800), false));
        assert!(!due(0, Duration::from_secs(86400), false));
        assert!(due(0, Duration::ZERO, true));
        assert!(!due(1, Duration::from_secs(59), false));
        assert!(due(1, Duration::from_secs(60), false));
    }
}
