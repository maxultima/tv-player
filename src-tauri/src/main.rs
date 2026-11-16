#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use tauri::Manager;

/// Jedna instance: prvni si drzi TCP port na loopbacku a na pozadi posloucha.
/// Druhe spusteni se pripoji (tim probudi okno bezici aplikace) a potichu skonci.
/// Zadna zavislost navic, jen std.
fn single_instance_setup(app: &tauri::App) {
    const PORT: u16 = 47831;
    match std::net::TcpListener::bind(("127.0.0.1", PORT)) {
        Ok(listener) => {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    if stream.is_ok() {
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                }
            });
        }
        Err(_) => {
            use std::io::Write;
            if let Ok(mut s) = std::net::TcpStream::connect_timeout(
                &"127.0.0.1:47831".parse().unwrap(),
                std::time::Duration::from_millis(300),
            ) {
                let _ = s.write_all(b"show");
                std::process::exit(0);
            }
            // Loopback je rozbity, ale jina instance neprokazana — pokracovat.
        }
    }
}

mod oneplay;
mod state;
mod vault;
mod winstate;

/// Jednoduchy HTTP klient bez CORS omezeni (frontend bezi na tauri://).
/// Slouzi pro API SledovaniTV/Oneplay po vlozeni uzivatelskeho tokenu.
#[tauri::command]
fn app_build() -> serde_json::Value {
    serde_json::json!({ "version": env!("CARGO_PKG_VERSION"), "time": env!("BUILD_TIME") })
}

/// Diagnosticky zapis (docasny): frontend posila snimky stavu/EPG ke cteni z disku.
#[tauri::command]
fn debug_dump(name: String, content: String) -> Result<(), String> {
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        || name.contains("..")
    {
        return Err("spatne jmeno".to_string());
    }
    let dir = std::env::temp_dir().join("tv-client-debug");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(name), content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn http_get(url: String, user_agent: Option<String>) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(&url);
    if let Some(ua) = user_agent {
        req = req.header(reqwest::header::USER_AGENT, ua);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, &text[..text.len().min(300)]));
    }
    Ok(text)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            http_get,
            oneplay::oneplay_call,
            vault::vault_set,
            vault::vault_get,
            vault::vault_clear,
            vault::vault_debug,
            app_build,
            debug_dump,
            winstate::win_save,
            winstate::win_apply,
            winstate::win_start_drag,
            winstate::win_info,
            winstate::win_toggle_fullscreen,
            winstate::win_minimize,
            winstate::win_maximize_toggle,
            winstate::win_close
        ])
        .setup(|app| {
            single_instance_setup(app);
            // Dekorace vzdy vypnute (okno bez nadpisu); zadny plugin je nesmi prepsat.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_decorations(false);
            }
            state::ensure_window_visible(app);
            // Pojistka: okno se vzdy ukaze, i kdyby frontend win_apply nikdy nezavolal.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(6)).await;
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.show();
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("chyba pri behu TV klienta");
}
