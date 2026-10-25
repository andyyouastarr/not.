//! Extend the existing WebView2 menu; never replace built-in edit commands.
#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use webview2_com::{Microsoft::Web::WebView2::Win32::*, *};
    use windows::core::{Interface, HSTRING, PWSTR};
    window.with_webview(|webview| unsafe {
        let install = || -> windows::core::Result<()> {
            let core = webview.controller().CoreWebView2()?;
            let environment: ICoreWebView2Environment9 = webview.environment().cast()?;
            let menu_core: ICoreWebView2_11 = core.cast()?;
            let mut token = 0;
            menu_core.add_ContextMenuRequested(
                &ContextMenuRequestedEventHandler::create(Box::new(move |sender, args| {
                    let (Some(sender), Some(args)) = (sender, args) else {
                        return Ok(());
                    };
                    let deferral = args.GetDeferral()?;
                    let failed_deferral = deferral.clone();
                    let environment = environment.clone();
                    let target = sender.clone();
                    let result = sender.ExecuteScript(
                        &HSTRING::from("window.__notTaskMenu?.prepare() ?? null"),
                        &ExecuteScriptCompletedHandler::create(Box::new(move |status, result| {
                            let add = || -> windows::core::Result<()> {
                                status?;
                                let Ok(value) = serde_json::from_str::<serde_json::Value>(&result)
                                else {
                                    return Ok(());
                                };
                                let Some(label) = value["label"].as_str() else {
                                    return Ok(());
                                };
                                let Some(id) = value["token"]
                                    .as_str()
                                    .filter(|s| uuid::Uuid::parse_str(s).is_ok())
                                else {
                                    return Ok(());
                                };
                                let items = args.MenuItems()?;
                                let mut count = 0;
                                items.Count(&mut count)?;
                                for index in 0..count {
                                    let existing = items.GetValueAtIndex(index)?;
                                    let mut name = PWSTR::null();
                                    existing.Name(&mut name)?;
                                    if CoTaskMemPWSTR::from(name).to_string() != "selectAll" {
                                        continue;
                                    }
                                    let item = environment.CreateContextMenuItem(
                                        &HSTRING::from(label),
                                        None,
                                        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND,
                                    )?;
                                    item.SetIsEnabled(value["enabled"].as_bool().unwrap_or(false))?;
                                    let script = format!("window.__notTaskMenu?.run('{}')", id);
                                    let selected_target = target.clone();
                                    let mut selected = 0;
                                    item.add_CustomItemSelected(
                                        &CustomItemSelectedEventHandler::create(Box::new(
                                            move |_, _| {
                                                selected_target.ExecuteScript(
                                                    &HSTRING::from(&script),
                                                    &ExecuteScriptCompletedHandler::create(
                                                        Box::new(|_, _| Ok(())),
                                                    ),
                                                )
                                            },
                                        )),
                                        &mut selected,
                                    )?;
                                    items.InsertValueAtIndex(index + 1, &item)?;
                                    #[cfg(debug_assertions)]
                                    if std::env::var_os("NOT_STUDIO_TEST_DATA_DIR").is_some() {
                                        let mut names = Vec::new();
                                        for i in 0..=count {
                                            let mut name = PWSTR::null();
                                            items.GetValueAtIndex(i)?.Name(&mut name)?;
                                            names.push(CoTaskMemPWSTR::from(name).to_string());
                                        }
                                        let probe = serde_json::json!({"names":names,"insertedIndex":index+1,"label":label});
                                        target.ExecuteScript(&HSTRING::from(format!("window.__notNativeMenuProbe={probe}")), &ExecuteScriptCompletedHandler::create(Box::new(|_,_| Ok(()))))?;
                                    }
                                    break;
                                }
                                Ok(())
                            };
                            let result = add();
                            let complete = deferral.Complete();
                            result.and(complete)
                        })),
                    );
                    if result.is_err() {
                        let _ = failed_deferral.Complete();
                    }
                    result
                })),
                &mut token,
            )?;
            Ok(())
        };
        if install().is_err() {
            eprintln!("Native context menu extension unavailable");
        }
    })
}
#[cfg(not(windows))]
pub fn install(_: &tauri::WebviewWindow) -> tauri::Result<()> {
    Ok(())
}
