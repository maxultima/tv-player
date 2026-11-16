use tauri::Manager;

/// Po startu zajisti, aby se hlavni okno ukazalo na dostupnem monitoru.
///
/// Plugin window-state obnovuje posledni velikost/pozici/fullscreen. Kdyz se
/// monitor mezitim zmenil (odpojeny, jine rozliseni), okno by skoncilo mimo
/// obraz. Proto overime, zda je ulozene umisteni viditelne, jinak okno
/// vycentrujeme s vychozim rozmerem.
pub fn ensure_window_visible(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let Ok(pos) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        let _ = window.center();
        return;
    };

    let cx = pos.x + (size.width as i32) / 2;
    let cy = pos.y + (size.height as i32) / 2;

    let visible = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .any(|m| {
            let mp = m.position();
            let ms = m.size();
            cx >= mp.x
                && cx < mp.x + ms.width as i32
                && cy >= mp.y
                && cy < mp.y + ms.height as i32
        });

    if !visible {
        let _ = window.set_fullscreen(false);
        let _ = window.center();
    }
}
