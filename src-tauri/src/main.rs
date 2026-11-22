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
mod recorder;
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

#[tauri::command]
async fn http_get_data_url(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let ct = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .split(';')
        .next()
        .unwrap_or("image/png")
        .to_string();
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut b64 = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for c in bytes.chunks(3) {
        let n = ((c[0] as u32) << 16)
            | ((*c.get(1).unwrap_or(&0) as u32) << 8)
            | (*c.get(2).unwrap_or(&0) as u32);
        b64.push(T[((n >> 18) & 63) as usize] as char);
        b64.push(T[((n >> 12) & 63) as usize] as char);
        b64.push(if c.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        b64.push(if c.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    Ok(format!("data:{};base64,{}", ct, b64))
}

#[tauri::command]
async fn net_check() -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
    else {
        return false;
    };
    for url in [
        "https://www.msftconnecttest.com/connecttest.txt",
        "https://clients3.google.com/generate_204",
    ] {
        if client.head(url).send().await.is_ok() {
            return true;
        }
    }
    false
}

#[tauri::command]
fn autostart_get() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let out = std::process::Command::new("reg")
            .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run", "/v", "TVClient"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| e.to_string())?;
        Ok(out.status.success())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(false)
    }
}

#[tauri::command]
fn autostart_set(enabled: bool) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        if enabled {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let val = format!("\"{}\"", exe.display());
            let out = std::process::Command::new("reg")
                .args(["add", key, "/v", "TVClient", "/t", "REG_SZ", "/d", &val, "/f"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            Ok(true)
        } else {
            let _ = std::process::Command::new("reg")
                .args(["delete", key, "/v", "TVClient", "/f"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            Ok(false)
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Ok(false)
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            http_get,
            http_get_data_url,
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
            winstate::win_close,
            autostart_get,
            autostart_set,
            net_check,
            recorder::rec_start,
            recorder::rec_stop,
            recorder::rec_status,
            recorder::default_rec_dir,
            recorder::pick_folder,
            recorder::rec_encoders,
            recorder::rec_transcode
        ])
        .setup(|app| {
            single_instance_setup(app);
            // Dekorace vzdy vypnute (okno bez nadpisu); zadny plugin je nesmi prepsat.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_decorations(false);
            }
            // Obnova geometrie rovnou v setupu (deterministicke, bez zavislosti na frontendu),
            // a pak kontrola viditelnosti na skutecne pozici.
            let _ = winstate::win_apply(app.handle().clone());
            // Ukladani geometrie pri presunu/zmeně velikosti (misto casovace): throttled na ~1 s.
            if let Some(w) = app.get_webview_window("main") {
                let h = app.handle().clone();
                let last = std::sync::Arc::new(std::sync::Mutex::new(std::time::Instant::now()));
                w.on_window_event(move |ev| {
                    use tauri::WindowEvent;
                    if !matches!(ev, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
                        return;
                    }
                    let save = match last.lock() {
                        Ok(mut t) => {
                            if t.elapsed() < std::time::Duration::from_secs(1) {
                                false
                            } else {
                                *t = std::time::Instant::now();
                                true
                            }
                        }
                        Err(_) => true,
                    };
                    if save {
                        let _ = winstate::win_save(h.clone());
                    }
                });
            }
            state::ensure_window_visible(app);
            // Pojistka: okno se vzdy ukaze, i kdyby neco selhalo.
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
