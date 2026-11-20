use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

struct RecJob {
    stop: Arc<AtomicBool>,
    bytes: Arc<AtomicU64>,
    started: Instant,
    file_path: String,
}

fn jobs() -> &'static Mutex<HashMap<String, RecJob>> {
    static JOBS: OnceLock<Mutex<HashMap<String, RecJob>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(target_os = "windows")]
fn set_keep_awake(awake: bool) {
    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    extern "system" {
        fn SetThreadExecutionState(esFlags: u32) -> u32;
    }
    let flags = if awake {
        ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    } else {
        ES_CONTINUOUS
    };
    unsafe {
        SetThreadExecutionState(flags);
    }
}

#[cfg(not(target_os = "windows"))]
fn set_keep_awake(_awake: bool) {}

fn update_awake_state() {
    let any = jobs().lock().map(|m| !m.is_empty()).unwrap_or(false);
    set_keep_awake(any);
}

async fn resolve_media_playlist(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    let base = resp.url().clone();
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !text.contains("#EXT-X-STREAM-INF") {
        return Ok(base.to_string());
    }
    let mut best_bw: u64 = 0;
    let mut best_url: Option<String> = None;
    let mut next_bw: Option<u64> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with("#EXT-X-STREAM-INF:") {
            let bw = line
                .split(',')
                .find_map(|part| part.trim().strip_prefix("BANDWIDTH="))
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0);
            next_bw = Some(bw);
        } else if !line.is_empty() && !line.starts_with('#') {
            if let Some(bw) = next_bw.take() {
                if let Ok(resolved) = base.join(line) {
                    if best_url.is_none() || bw >= best_bw {
                        best_bw = bw;
                        best_url = Some(resolved.to_string());
                    }
                }
            }
        }
    }
    Ok(best_url.unwrap_or_else(|| base.to_string()))
}

#[tauri::command]
pub async fn rec_start(src: String, url: String, file_path: String) -> Result<String, String> {
    if src.is_empty() || url.is_empty() || file_path.is_empty() {
        return Err("Chybí parametry nahrávání.".to_string());
    }
    let path = PathBuf::from(&file_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Nelze vytvořit složku: {}", e))?;
    }
    // Vytvořit čistý soubor od nuly (přepsat případný starý zbytek).
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| format!("Nelze otevřít soubor: {}", e))?;

    // Zastavit případné předchozí nahrávání na stejném zdroji.
    if let Ok(mut map) = jobs().lock() {
        if let Some(old) = map.remove(&src) {
            old.stop.store(true, Ordering::Relaxed);
        }
    }

    let stop = Arc::new(AtomicBool::new(false));
    let bytes = Arc::new(AtomicU64::new(0));
    if let Ok(mut map) = jobs().lock() {
        map.insert(
            src.clone(),
            RecJob {
                stop: stop.clone(),
                bytes: bytes.clone(),
                started: Instant::now(),
                file_path: file_path.clone(),
            },
        );
    }
    update_awake_state();

    let stop_bg = stop.clone();
    let bytes_bg = bytes.clone();
    let src_bg = src.clone();
    tokio::spawn(async move {
        let Ok(client) = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
            .build()
        else {
            return;
        };
        let mut media_url = resolve_media_playlist(&client, &url)
            .await
            .unwrap_or_else(|_| url.clone());
        let mut seen: HashSet<String> = HashSet::new();
        let mut wrote_init = false;
        let mut first_poll = true;
        let mut last_seq: Option<u64> = None;

        while !stop_bg.load(Ordering::Relaxed) {
            let playlist_res = client.get(&media_url).send().await;
            if let Ok(resp) = playlist_res {
                let base = resp.url().clone();
                if resp.status().is_success() {
                    if let Ok(text) = resp.text().await {
                        if text.contains("#EXT-X-STREAM-INF") {
                            if let Ok(resolved) = resolve_media_playlist(&client, base.as_str()).await {
                                media_url = resolved;
                            }
                        } else {
                            let mut media_seq: Option<u64> = None;
                            let mut segs: Vec<String> = Vec::new();
                            for raw in text.lines() {
                                let line = raw.trim();
                                if line.is_empty() {
                                    continue;
                                }
                                if let Some(v) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
                                    media_seq = v.trim().parse::<u64>().ok();
                                    continue;
                                }
                                if !wrote_init && line.starts_with("#EXT-X-MAP:") {
                                    if let Some(uri) = line.split("URI=\"").nth(1).and_then(|s| s.split('"').next()) {
                                        if let Ok(init_url) = base.join(uri) {
                                            if let Ok(r) = client.get(init_url).send().await {
                                                if r.status().is_success() {
                                                    if let Ok(data) = r.bytes().await {
                                                        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
                                                            if f.write_all(&data).is_ok() {
                                                                bytes_bg.fetch_add(data.len() as u64, Ordering::Relaxed);
                                                                wrote_init = true;
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    continue;
                                }
                                if line.starts_with('#') {
                                    continue;
                                }
                                if let Ok(seg_url) = base.join(line) {
                                    segs.push(seg_url.to_string());
                                }
                            }
                            let skip_first = if first_poll && segs.len() > 2 { segs.len() - 2 } else { 0 };
                            first_poll = false;
                            for (idx, seg_str) in segs.into_iter().enumerate() {
                                if stop_bg.load(Ordering::Relaxed) {
                                    break;
                                }
                                let seq = media_seq.map(|m| m + idx as u64);
                                if idx < skip_first {
                                    seen.insert(seg_str);
                                    if let Some(s) = seq {
                                        last_seq = Some(last_seq.map_or(s, |prev| prev.max(s)));
                                    }
                                    continue;
                                }
                                if let (Some(s), Some(ls)) = (seq, last_seq) {
                                    if s <= ls {
                                        continue;
                                    }
                                }
                                if seen.contains(&seg_str) {
                                    continue;
                                }
                                seen.insert(seg_str.clone());
                                if let Some(s) = seq {
                                    last_seq = Some(last_seq.map_or(s, |prev| prev.max(s)));
                                }
                                if let Ok(seg_resp) = client.get(&seg_str).send().await {
                                    if seg_resp.status().is_success() {
                                        if let Ok(data) = seg_resp.bytes().await {
                                            if let Ok(mut f) = OpenOptions::new()
                                                .create(true)
                                                .append(true)
                                                .open(&path)
                                            {
                                                if f.write_all(&data).is_ok() {
                                                    bytes_bg.fetch_add(data.len() as u64, Ordering::Relaxed);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            for _ in 0..8 {
                if stop_bg.load(Ordering::Relaxed) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
        if let Ok(mut map) = jobs().lock() {
            if let Some(cur) = map.get(&src_bg) {
                if Arc::ptr_eq(&cur.stop, &stop_bg) {
                    map.remove(&src_bg);
                }
            }
        }
        update_awake_state();
    });

    Ok(file_path)
}

#[tauri::command]
pub async fn rec_stop(src: String) -> Result<u64, String> {
    let bytes = if let Ok(mut map) = jobs().lock() {
        if let Some(job) = map.remove(&src) {
            job.stop.store(true, Ordering::Relaxed);
            job.bytes.load(Ordering::Relaxed)
        } else {
            0
        }
    } else {
        0
    };
    update_awake_state();
    Ok(bytes)
}

#[tauri::command]
pub fn rec_status() -> serde_json::Value {
    let mut out = serde_json::Map::new();
    if let Ok(map) = jobs().lock() {
        for (src, job) in map.iter() {
            out.insert(
                src.clone(),
                serde_json::json!({
                    "active": !job.stop.load(Ordering::Relaxed),
                    "elapsedSec": job.started.elapsed().as_secs(),
                    "bytes": job.bytes.load(Ordering::Relaxed),
                    "filePath": job.file_path,
                }),
            );
        }
    }
    serde_json::Value::Object(out)
}

#[tauri::command]
pub fn default_rec_dir() -> String {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    let p = PathBuf::from(home).join("Videos").join("TV Client");
    p.to_string_lossy().to_string()
}

#[tauri::command]
pub async fn pick_folder(initial: Option<String>) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let init_esc = initial
            .unwrap_or_default()
            .replace('\'', "''");
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms; \
             $d = New-Object System.Windows.Forms.FolderBrowserDialog; \
             $d.Description = 'Vyber složku pro ukládání nahrávek'; \
             if ('{}' -and (Test-Path '{}')) {{ $d.SelectedPath = '{}' }}; \
             if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{ [Console]::Out.Write($d.SelectedPath) }}",
            init_esc, init_esc, init_esc
        );
        let out = tokio::task::spawn_blocking(move || {
            std::process::Command::new("powershell")
                .args(["-NoProfile", "-STA", "-Command", &script])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            Ok(None)
        } else {
            Ok(Some(s))
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = initial;
        Ok(None)
    }
}

fn find_ffmpeg() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let local = dir.join(if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" });
            if local.exists() {
                return Some(local);
            }
        }
    }
    Some(PathBuf::from("ffmpeg"))
}

fn run_ffmpeg_output(ffmpeg: &PathBuf, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = std::process::Command::new(ffmpeg);
    cmd.args(args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.output().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rec_encoders() -> serde_json::Value {
    let list = tokio::task::spawn_blocking(|| {
        let mut out: Vec<serde_json::Value> = Vec::new();
        if let Some(ff) = find_ffmpeg() {
            if let Ok(res) = run_ffmpeg_output(&ff, &["-hide_banner", "-encoders"]) {
                if res.status.success() {
                    let txt = String::from_utf8_lossy(&res.stdout);
                    let candidates = [
                        ("hevc_nvenc", "MP4 · HEVC (NVIDIA NVENC)"),
                        ("av1_nvenc", "MP4 · AV1 (NVIDIA NVENC)"),
                        ("hevc_qsv", "MP4 · HEVC (Intel QSV)"),
                        ("av1_qsv", "MP4 · AV1 (Intel QSV)"),
                        ("hevc_amf", "MP4 · HEVC (AMD AMF)"),
                        ("av1_amf", "MP4 · AV1 (AMD AMF)"),
                        ("libx265", "MP4 · HEVC (CPU)"),
                    ];
                    for (id, label) in candidates {
                        if txt.contains(id) {
                            out.push(serde_json::json!({ "id": id, "label": label, "ext": "mp4" }));
                        }
                    }
                }
            }
        }
        out.push(serde_json::json!({ "id": "ts", "label": "TS (originál, bez překódování)", "ext": "ts" }));
        serde_json::Value::Array(out)
    })
    .await
    .unwrap_or_else(|_| {
        serde_json::json!([{ "id": "ts", "label": "TS (originál, bez překódování)", "ext": "ts" }])
    });
    list
}

#[tauri::command]
pub async fn rec_transcode(ts_path: String, encoder: String) -> Result<String, String> {
    if encoder.is_empty() || encoder == "ts" {
        return Ok(ts_path);
    }
    let ff = find_ffmpeg().ok_or_else(|| "ffmpeg nenalezen".to_string())?;
    let src_p = PathBuf::from(&ts_path);
    let mut dst_p = src_p.clone();
    dst_p.set_extension("mp4");
    let dst_str = dst_p.to_string_lossy().to_string();
    let enc = encoder.clone();
    let ts_c = ts_path.clone();
    let dst_c = dst_str.clone();
    let res = tokio::task::spawn_blocking(move || {
        let mut args: Vec<String> = vec![
            "-y".into(),
            "-i".into(),
            ts_c,
            "-c:v".into(),
            enc.clone(),
        ];
        match enc.as_str() {
            "hevc_nvenc" => {
                args.extend(["-rc", "vbr", "-cq", "31", "-b:v", "0", "-preset", "p5"].into_iter().map(String::from));
            }
            "av1_nvenc" => {
                args.extend(["-rc", "vbr", "-cq", "38", "-b:v", "0", "-preset", "p5"].into_iter().map(String::from));
            }
            "hevc_qsv" => {
                args.extend(["-global_quality", "31"].into_iter().map(String::from));
            }
            "av1_qsv" => {
                args.extend(["-global_quality", "38"].into_iter().map(String::from));
            }
            "hevc_amf" => {
                args.extend(["-rc", "cqp", "-qp_i", "31", "-qp_p", "31"].into_iter().map(String::from));
            }
            "av1_amf" => {
                args.extend(["-rc", "cqp", "-qp_i", "38", "-qp_p", "38"].into_iter().map(String::from));
            }
            _ => {
                args.extend(["-crf", "28", "-preset", "medium"].into_iter().map(String::from));
            }
        }
        args.extend(
            ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", &dst_c]
                .into_iter()
                .map(String::from),
        );
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        run_ffmpeg_output(&ff, &arg_refs)
    })
    .await
    .map_err(|e| e.to_string())??;

    if res.status.success() && std::fs::metadata(&dst_p).map(|m| m.len() > 0).unwrap_or(false) {
        let _ = std::fs::remove_file(&src_p);
        Ok(dst_str)
    } else {
        let err = String::from_utf8_lossy(&res.stderr);
        Err(format!("ffmpeg selhal (ponechán .ts): {}", err.lines().last().unwrap_or("")))
    }
}
