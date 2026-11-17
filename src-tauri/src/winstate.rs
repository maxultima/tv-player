use tauri::Manager;

/// Geometrie hlavniho okna drzena Rustem (nezavisle na tvaru JS API).
/// Soubor: <app-data>/winstate.json — {x, y, w, h, fs, v}.
/// Souradnice jsou LOGICKE (nezavisle na DPI monitoru): fyzicke pixely se mezi
/// monitory s ruznym scale rozchazeji a okno preteka. Zapis pri presunu/zavreni,
/// cteni + aplikace pri startu (vcetne show), takze okno se ukaze rovnou tam,
/// kde skoncilo.

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
struct WinState {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    fs: bool,
    #[serde(default)]
    v: u32,
}

/// Stary format v1 (fyzicke int pixely) -> v2 (logicke): prevod danym scale.
/// Volajici predava scale monitoru, na nemz okno lezelo (viz scale_at).
fn migrate_v1(old: &serde_json::Value, scale: f64) -> Option<WinState> {
    if old.get("v").and_then(|v| v.as_u64()) == Some(2) {
        return None;
    }
    let (x, y, w, h) = (
        old.get("x")?.as_i64()? as f64,
        old.get("y")?.as_i64()? as f64,
        old.get("w")?.as_u64()? as f64,
        old.get("h")?.as_u64()? as f64,
    );
    if scale <= 0.0 {
        return None;
    }
    Some(WinState {
        x: x / scale,
        y: y / scale,
        w: w / scale,
        h: h / scale,
        fs: old.get("fs").and_then(|v| v.as_bool()).unwrap_or(false),
        v: 2,
    })
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
    let scale = w.scale_factor().unwrap_or(1.0).max(0.01);
    let st = WinState {
        x: p.x as f64 / scale,
        y: p.y as f64 / scale,
        w: s.width as f64 / scale,
        h: s.height as f64 / scale,
        fs,
        v: 2,
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
    Window { x: f64, y: f64, w: f64, h: f64 },
    ShowOnly,
}

fn parse_v2(bytes: &[u8]) -> Option<WinState> {
    let v: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    if v.get("v").and_then(|x| x.as_u64()) != Some(2) {
        return None;
    }
    let st: WinState = serde_json::from_value(v).ok()?;
    if st.fs || (st.w >= 400.0 && st.h >= 300.0) {
        return Some(st);
    }
    None
}

/// Scale monitoru pod bodem (fyzicke pixely); bez monitoru 1.0.
fn scale_at(app: &tauri::AppHandle, cx: f64, cy: f64) -> f64 {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .find(|m| {
            let mp = m.position();
            let ms = m.size();
            cx >= mp.x as f64
                && cx < mp.x as f64 + ms.width as f64
                && cy >= mp.y as f64
                && cy < mp.y as f64 + ms.height as f64
        })
        .map(|m| m.scale_factor())
        .unwrap_or(1.0)
}

fn load_state(raw: Option<&[u8]>, app: &tauri::AppHandle) -> Option<WinState> {
    let bytes = raw?;
    if let Some(st) = parse_v2(bytes) {
        return Some(st);
    }
    let v: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let st = migrate_v1(&v, scale_at(app, 0.0, 0.0)).or_else(|| {
        // Stred stareho okna muze lezet na jinem monitoru s jinym scale.
        let (x, y, w, h) = (
            v.get("x")?.as_i64()? as f64,
            v.get("y")?.as_i64()? as f64,
            v.get("w")?.as_u64()? as f64,
            v.get("h")?.as_u64()? as f64,
        );
        migrate_v1(&v, scale_at(app, x + w / 2.0, y + h / 2.0))
    })?;
    (!st.fs && st.w >= 400.0 && st.h >= 300.0).then_some(st)
}

/// Cista geometrie: orez (x, y, w, h) do logickeho obdelnika monitoru.
fn clamp_rect(x: f64, y: f64, w: f64, h: f64, mx: f64, my: f64, mw: f64, mh: f64) -> (f64, f64, f64, f64) {
    let nw = w.min(mw).max(200.0);
    let nh = h.min(mh).max(150.0);
    let nx = x.clamp(mx, (mx + mw - nw).max(mx));
    let ny = y.clamp(my, (my + mh - nh).max(my));
    (nx, ny, nw, nh)
}

/// Najde monitor pod stredem okna (logicke souradnice) a oreze na nej.
fn clamp_to_monitor(app: &tauri::AppHandle, x: f64, y: f64, w: f64, h: f64) -> (f64, f64, f64, f64) {
    let cx = x + w / 2.0;
    let cy = y + h / 2.0;
    for m in app.available_monitors().unwrap_or_default() {
        let s = m.scale_factor().max(0.01);
        let mp = m.position();
        let ms = m.size();
        let (mx, my, mw, mh) = (
            mp.x as f64 / s,
            mp.y as f64 / s,
            ms.width as f64 / s,
            ms.height as f64 / s,
        );
        if cx >= mx && cx < mx + mw && cy >= my && cy < my + mh {
            return clamp_rect(x, y, w, h, mx, my, mw, mh);
        }
    }
    (x, y, w, h)
}

fn apply_plan(st: Option<WinState>) -> ApplyPlan {
    match st {
        Some(s) if s.fs => ApplyPlan::Fullscreen,
        Some(s) => ApplyPlan::Window { x: s.x, y: s.y, w: s.w, h: s.h },
        None => ApplyPlan::ShowOnly,
    }
}

#[tauri::command]
pub fn win_apply(app: tauri::AppHandle) -> Result<bool, String> {
    let w = app.get_webview_window("main").ok_or("zadne hlavni okno")?;
    let mut applied = false;
    if let Ok(bytes) = std::fs::read(winstate_path(&app)?) {
        match apply_plan(load_state(Some(&bytes), &app)) {
            ApplyPlan::Fullscreen => {
                let _ = w.set_fullscreen(true);
                applied = true;
            }
            ApplyPlan::Window { x, y, w: ww, h } => {
                // Orezat na cilovy monitor, aby okno nikdy nepretekalo (zmena rozliseni/DPI).
                let (nx, ny, nw, nh) = clamp_to_monitor(&app, x, y, ww, h);
                let _ = w.set_size(tauri::Size::Logical(tauri::LogicalSize {
                    width: nw,
                    height: nh,
                }));
                let _ = w.set_position(tauri::Position::Logical(tauri::LogicalPosition { x: nx, y: ny }));
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

    fn state(fs: bool, w: f64, h: f64) -> Vec<u8> {
        serde_json::to_vec(&WinState {
            x: 10.0,
            y: 20.0,
            w,
            h,
            fs,
            v: 2,
        })
        .unwrap()
    }

    fn plan_of(bytes: &[u8]) -> ApplyPlan {
        apply_plan(parse_v2(bytes))
    }

    #[test]
    fn fullscreen_ma_prednost() {
        assert_eq!(plan_of(&state(true, 0.0, 0.0)), ApplyPlan::Fullscreen);
    }

    #[test]
    fn platna_geometrie_se_pouzije() {
        assert_eq!(
            plan_of(&state(false, 1280.0, 720.0)),
            ApplyPlan::Window {
                x: 10.0,
                y: 20.0,
                w: 1280.0,
                h: 720.0
            }
        );
    }

    #[test]
    fn malinke_okno_se_ignoruje() {
        assert_eq!(plan_of(&state(false, 100.0, 100.0)), ApplyPlan::ShowOnly);
    }

    #[test]
    fn chybejici_soubor_jen_ukaze() {
        assert_eq!(apply_plan(None), ApplyPlan::ShowOnly);
    }

    #[test]
    fn poskozeny_soubor_jen_ukaze() {
        assert_eq!(parse_v2(b"{nesmysl"), None);
    }

    #[test]
    fn roundtrip_serde() {
        let st = WinState {
            x: -5.5,
            y: 99.25,
            w: 800.0,
            h: 600.0,
            fs: false,
            v: 2,
        };
        let back: WinState = serde_json::from_slice(&serde_json::to_vec(&st).unwrap()).unwrap();
        assert_eq!(
            (back.x, back.y, back.w, back.h, back.fs, back.v),
            (-5.5, 99.25, 800.0, 600.0, false, 2)
        );
    }

    #[test]
    fn orez_na_monitor() {
        // Vetsi nez monitor + posunute ven: zmensi a zasune dovnitr.
        assert_eq!(
            clamp_rect(-2000.0, 500.0, 1968.0, 1100.0, -1920.0, 584.0, 1920.0, 1080.0),
            (-1920.0, 584.0, 1920.0, 1080.0)
        );
        // Mensi a uvnitr: beze zmeny.
        assert_eq!(
            clamp_rect(-1500.0, 700.0, 800.0, 600.0, -1920.0, 584.0, 1920.0, 1080.0),
            (-1500.0, 700.0, 800.0, 600.0)
        );
    }

    #[test]
    fn migrace_v1_deli_scale() {
        let old = serde_json::json!({"x": -1928, "y": 576, "w": 1936, "h": 1096, "fs": false});
        let st = migrate_v1(&old, 1.0).expect("migrace");
        assert_eq!((st.x, st.y, st.w, st.h, st.v), (-1928.0, 576.0, 1936.0, 1096.0, 2));
        let st2 = migrate_v1(&old, 1.25).expect("migrace");
        assert!((st2.w - 1548.8).abs() < 0.01);
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
    let (x, y) = w.outer_position().map(|p| (p.x, p.y)).unwrap_or((0, 0));
    let (ww, hh) = w.outer_size().map(|s| (s.width, s.height)).unwrap_or((0, 0));
    let scale = w.scale_factor().unwrap_or(0.0);
    let mons: Vec<serde_json::Value> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let mp = m.position();
            let ms = m.size();
            serde_json::json!({"x": mp.x, "y": mp.y, "w": ms.width, "h": ms.height, "scale": m.scale_factor()})
        })
        .collect();
    Ok(serde_json::json!({
        "decorated": w.is_decorated().map_err(|e| e.to_string())?,
        "visible": w.is_visible().map_err(|e| e.to_string())?,
        "fullscreen": w.is_fullscreen().map_err(|e| e.to_string())?,
        "x": x, "y": y, "w": ww, "h": hh, "scale": scale, "monitors": mons,
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
