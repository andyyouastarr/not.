use crate::{crypto::Result, vault};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Copy, Default, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    Dark,
    Light,
}

#[derive(Clone, Copy, Default, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preferences {
    pub theme: Theme,
}

pub fn read(root: &Path) -> Preferences {
    std::fs::read(root.join("appearance.json"))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}
pub fn save(root: &Path, value: Preferences) -> Result<()> {
    vault::atomic(
        &root.join("appearance.json"),
        &serde_json::to_vec(&value).unwrap(),
    )
}
pub fn apply(window: &tauri::WebviewWindow, value: Preferences) -> tauri::Result<()> {
    let light = value.theme == Theme::Light;
    window.set_theme(Some(if light {
        tauri::Theme::Light
    } else {
        tauri::Theme::Dark
    }))?;
    window.set_background_color(Some(if light {
        tauri::window::Color(238, 239, 243, 255)
    } else {
        tauri::window::Color(23, 23, 29, 255)
    }))?;
    #[cfg(windows)]
    window.with_webview(move |webview| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use windows::core::Interface;
        let update = || -> windows::core::Result<()> {
            let core: ICoreWebView2_13 = webview.controller().CoreWebView2()?.cast()?;
            core.Profile()?.SetPreferredColorScheme(if light {
                COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT
            } else {
                COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK
            })
        };
        // Older WebView2 runtimes may not expose profile theming. The app/window
        // theme remains valid; no custom replacement for native controls.
        let _ = update();
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn device_theme_roundtrip_fallback_and_atomic_failure() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert_eq!(read(root).theme, Theme::Dark);
        let light = Preferences {
            theme: Theme::Light,
        };
        save(root, light).unwrap();
        assert_eq!(read(root), light);
        assert_eq!(
            std::fs::read_to_string(root.join("appearance.json")).unwrap(),
            r#"{"theme":"light"}"#
        );
        std::fs::write(root.join("appearance.json"), "broken").unwrap();
        assert_eq!(read(root), Preferences::default());
        assert!(serde_json::from_str::<Preferences>(r#"{"theme":"system"}"#).is_err());
        assert!(serde_json::from_str::<Preferences>(r#"{"theme":"light","secret":"x"}"#).is_err());
        std::fs::remove_file(root.join("appearance.json")).unwrap();
        std::fs::create_dir(root.join("appearance.json")).unwrap();
        assert!(save(root, light).is_err());
        assert!(root.join("appearance.json").is_dir());
    }
}
