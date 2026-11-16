use tauri::Manager;

/// Geometrie hlavniho okna drzena Rustem (nezavisle na tvaru JS API).
/// Soubor: <app-data>/winstate.json — {x, y, w, h, fs}.
/// Zapis pri presunu/zavreni, cteni + aplikace pri startu (vcetne show),
/// takze okno se ukaze rovnou tam, kde skoncilo.

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
struct WinState {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    fs: bool,
}

fn winstate_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("winstate.json"))
}

#[tauri::command]
pub fn win_save(app: tauri::AppHandle) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or("zadne hlavni okno")?;
    let p = w.outer_position().map_err(|e| e.to_string())?;
    let s = w.outer_size().map_err(|e| e.to_string())?;
    let fs = w.is_fullscreen().map_err(|e| e.to_string())?;
    let st = WinState {
        x: p.x,
        y: p.y,
        w: s.width,
        h: s.height,
        fs,
    };
    std::fs::write(
        winstate_path(&app)?,
        serde_json::to_vec(&st).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// Ciste rozhodnuti bez vedlejsich efektu (testovatelne): co s oknem udelat.
#[derive(Debug, PartialEq)]
enum ApplyPlan {
    Fullscreen,
    Window { x: i32, y: i32, w: u32, h: u32 },
    ShowOnly,
}

fn apply_plan(raw: Option<&[u8]>) -> ApplyPlan {
    let bytes = match raw {
        Some(b) => b,
        None => return ApplyPlan::ShowOnly,
    };
    let st: WinState = match serde_json::from_slice(bytes) {
        Ok(s) => s,
        Err(_) => return ApplyPlan::ShowOnly,
    };
    if st.fs {
        ApplyPlan::Fullscreen
    } else if st.w >= 400 && st.h >= 300 {
        ApplyPlan::Window {
            x: st.x,
            y: st.y,
            w: st.w,
            h: st.h,
        }
    } else {
        ApplyPlan::ShowOnly
    }
}

#[tauri::command]
pub fn win_apply(app: tauri::AppHandle) -> Result<bool, String> {
    let w = app.get_webview_window("main").ok_or("zadne hlavni okno")?;
    let mut applied = false;
    if let Ok(bytes) = std::fs::read(winstate_path(&app)?) {
        match apply_plan(Some(&bytes)) {
            ApplyPlan::Fullscreen => {
                let _ = w.set_fullscreen(true);
                applied = true;
            }
            ApplyPlan::Window { x, y, w: ww, h } => {
                let _ = w.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                    width: ww,
                    height: h,
                }));
                let _ = w.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
                applied = true;
            }
            ApplyPlan::ShowOnly => {}
        }
    }
    let _ = w.show();
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(fs: bool, w: u32, h: u32) -> Vec<u8> {
        serde_json::to_vec(&WinState {
            x: 10,
            y: 20,
            w,
            h,
            fs,
        })
        .unwrap()
    }

    #[test]
    fn fullscreen_ma_prednost() {
        assert_eq!(apply_plan(Some(&state(true, 0, 0))), ApplyPlan::Fullscreen);
    }

    #[test]
    fn platna_geometrie_se_pouzije() {
        assert_eq!(
            apply_plan(Some(&state(false, 1280, 720))),
            ApplyPlan::Window {
                x: 10,
                y: 20,
                w: 1280,
                h: 720
            }
        );
    }

    #[test]
    fn malinke_okno_se_ignoruje() {
        assert_eq!(apply_plan(Some(&state(false, 100, 100))), ApplyPlan::ShowOnly);
    }

    #[test]
    fn chybejici_soubor_jen_ukaze() {
        assert_eq!(apply_plan(None), ApplyPlan::ShowOnly);
    }

    #[test]
    fn poskozeny_soubor_jen_ukaze() {
        assert_eq!(apply_plan(Some(b"{nesmysl")), ApplyPlan::ShowOnly);
    }

    #[test]
    fn roundtrip_serde() {
        let st = WinState {
            x: -5,
            y: 99,
            w: 800,
            h: 600,
            fs: false,
        };
        let back: WinState = serde_json::from_slice(&serde_json::to_vec(&st).unwrap()).unwrap();
        assert_eq!((back.x, back.y, back.w, back.h, back.fs), (-5, 99, 800, 600, false));
    }
}

#[tauri::command]
pub fn win_start_drag(app: tauri::AppHandle) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or("zadne hlavni okno")?;
    w.start_dragging().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn win_info(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let w = app.get_webview_window("main").ok_or("zadne hlavni okno")?;
    Ok(serde_json::json!({
        "decorated": w.is_decorated().map_err(|e| e.to_string())?,
        "visible": w.is_visible().map_err(|e| e.to_string())?,
        "fullscreen": w.is_fullscreen().map_err(|e| e.to_string())?,
    }))
}

#[tauri::command]
pub fn win_minimize(app: tauri::AppHandle) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or("zadne hlavni okno")?;
    w.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn win_maximize_toggle(app: tauri::AppHandle) -> Result<bool, String> {
    let w = app.get_webview_window("main").ok_or("zadne hlavni okno")?;
    let maxed = w.is_maximized().map_err(|e| e.to_string())?;
    if maxed {
        w.unmaximize().map_err(|e| e.to_string())?;
    } else {
        w.maximize().map_err(|e| e.to_string())?;
    }
    Ok(!maxed)
}

#[tauri::command]
pub fn win_close(app: tauri::AppHandle) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or("zadne hlavni okno")?;
    w.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn win_toggle_fullscreen(app: tauri::AppHandle) -> Result<bool, String> {
    let w = app.get_webview_window("main").ok_or("zadne hlavni okno")?;
    let cur = w.is_fullscreen().map_err(|e| e.to_string())?;
    w.set_fullscreen(!cur).map_err(|e| e.to_string())?;
    Ok(!cur)
}
