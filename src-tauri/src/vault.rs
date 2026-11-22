use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce as AesNonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chacha20poly1305::{ChaCha20Poly1305, Nonce as ChaChaNonce};
use rand::RngCore;
use std::collections::BTreeMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const ENC_PREFIX: &str = "enc:v1:";

/// Sifrovany trezor pro prihlasovaci udaje.
/// - Klic: 32 nahodnych bytu v `vault.key` (profil uzivatele).
/// - Data: AES-256-GCM s verzovanym prefixem `enc:v1:` v `vault.dat`.
/// - Stary format (ChaCha20-Poly1305 JSON) se pri prvnim cteni automaticky zmigruje.

fn vault_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn load_key(app: &AppHandle) -> Result<[u8; 32], String> {
    let path = vault_dir(app)?.join("vault.key");
    if let Ok(bytes) = std::fs::read(&path) {
        if bytes.len() == 32 {
            let mut k = [0u8; 32];
            k.copy_from_slice(&bytes);
            return Ok(k);
        }
    }
    let mut k = [0u8; 32];
    OsRng.fill_bytes(&mut k);
    std::fs::write(&path, k).map_err(|e| e.to_string())?;
    Ok(k)
}

/// Ciste sifrovani AES-256-GCM bez zavislosti na souborech (testovatelne).
/// Vraci (nonce_base64, ciphertext_base64); kazde volani ma nahodny 12B nonce.
fn encrypt_map(key: &[u8; 32], map: &BTreeMap<String, String>) -> Result<(String, String), String> {
    let cipher = Aes256Gcm::new(key.into());
    let mut nonce_b = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_b);
    let pt = serde_json::to_vec(map).map_err(|e| e.to_string())?;
    let ct = cipher
        .encrypt(AesNonce::from_slice(&nonce_b), pt.as_slice())
        .map_err(|e| e.to_string())?;
    Ok((B64.encode(nonce_b), B64.encode(ct)))
}

fn decrypt_map(
    key: &[u8; 32],
    nonce_b64: &str,
    ct_b64: &str,
) -> Result<BTreeMap<String, String>, String> {
    let nonce_b = B64.decode(nonce_b64).map_err(|e| e.to_string())?;
    if nonce_b.len() != 12 {
        return Err("neplatny nonce".to_string());
    }
    let ct = B64.decode(ct_b64).map_err(|e| e.to_string())?;
    let cipher = Aes256Gcm::new(key.into());
    let pt = cipher
        .decrypt(AesNonce::from_slice(&nonce_b), ct.as_slice())
        .map_err(|_| "trezor nelze odsifrovat".to_string())?;
    serde_json::from_slice(&pt).map_err(|e| e.to_string())
}

fn decrypt_legacy_chacha(
    key: &[u8; 32],
    nonce_b64: &str,
    ct_b64: &str,
) -> Result<BTreeMap<String, String>, String> {
    let nonce_b = B64.decode(nonce_b64).map_err(|e| e.to_string())?;
    if nonce_b.len() != 12 {
        return Err("neplatny nonce".to_string());
    }
    let ct = B64.decode(ct_b64).map_err(|e| e.to_string())?;
    let cipher = ChaCha20Poly1305::new(key.into());
    let pt = cipher
        .decrypt(ChaChaNonce::from_slice(&nonce_b), ct.as_slice())
        .map_err(|_| "trezor nelze odsifrovat".to_string())?;
    serde_json::from_slice(&pt).map_err(|e| e.to_string())
}

fn read_store(app: &AppHandle) -> Result<BTreeMap<String, String>, String> {
    let path = vault_dir(app)?.join("vault.dat");
    let blob = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return Ok(BTreeMap::new()),
    };
    let key = load_key(app)?;
    if let Ok(s) = std::str::from_utf8(&blob) {
        if let Some(rest) = s.trim().strip_prefix(ENC_PREFIX) {
            let mut parts = rest.splitn(2, ':');
            let n = parts.next().unwrap_or("");
            let c = parts.next().unwrap_or("");
            return decrypt_map(&key, n, c);
        }
    }
    // Automaticka jednorazova migrace ze stareho ChaCha20-Poly1305 JSON formatu.
    let v: serde_json::Value = serde_json::from_slice(&blob).map_err(|_| "neplatny format trezoru".to_string())?;
    let nonce_b64 = v.get("nonce").and_then(|x| x.as_str()).ok_or("odmitnut nezasifrovany trezor")?;
    let ct_b64 = v.get("ct").and_then(|x| x.as_str()).ok_or("odmitnut nezasifrovany trezor")?;
    let map = decrypt_legacy_chacha(&key, nonce_b64, ct_b64)?;
    let _ = write_store(app, &map);
    Ok(map)
}

fn write_store(app: &AppHandle, map: &BTreeMap<String, String>) -> Result<(), String> {
    let key = load_key(app)?;
    let (nonce_b64, ct_b64) = encrypt_map(&key, map)?;
    let payload = format!("{}{}:{}", ENC_PREFIX, nonce_b64, ct_b64);
    std::fs::write(vault_dir(app)?.join("vault.dat"), payload.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> [u8; 32] {
        [7u8; 32]
    }

    fn sample_map() -> BTreeMap<String, String> {
        let mut m = BTreeMap::new();
        m.insert("sltv.deviceId".to_string(), "6362864903".to_string());
        m.insert("sltv.devicePass".to_string(), "tajneheslo123".to_string());
        m.insert("oneplay.token".to_string(), "bearer-abc".to_string());
        m
    }

    #[test]
    fn roundtrip_ok() {
        let (n, c) = encrypt_map(&test_key(), &sample_map()).unwrap();
        assert_eq!(decrypt_map(&test_key(), &n, &c).unwrap(), sample_map());
    }

    #[test]
    fn roundtrip_prazdna_mapa() {
        let (n, c) = encrypt_map(&test_key(), &BTreeMap::new()).unwrap();
        assert!(decrypt_map(&test_key(), &n, &c).unwrap().is_empty());
    }

    #[test]
    fn nonce_je_nahodny() {
        let (n1, _) = encrypt_map(&test_key(), &sample_map()).unwrap();
        let (n2, _) = encrypt_map(&test_key(), &sample_map()).unwrap();
        assert_ne!(n1, n2);
    }

    #[test]
    fn spatny_klic_selze() {
        let (n, c) = encrypt_map(&test_key(), &sample_map()).unwrap();
        assert!(decrypt_map(&[9u8; 32], &n, &c).is_err());
    }

    #[test]
    fn poskozeny_ciphertext_selze() {
        let (n, c) = encrypt_map(&test_key(), &sample_map()).unwrap();
        let mut raw = B64.decode(&c).unwrap();
        raw[10] ^= 0xff;
        assert!(decrypt_map(&test_key(), &n, &B64.encode(&raw)).is_err());
    }

    #[test]
    fn nesmyslny_base64_selze() {
        assert!(decrypt_map(&test_key(), "!!!", "???").is_err());
    }
}

#[tauri::command]
pub fn vault_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let mut map = read_store(&app)?;
    map.insert(key, value);
    write_store(&app, &map)
}

#[tauri::command]
pub fn vault_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
    Ok(read_store(&app)?.get(&key).cloned())
}

/// Smaze vsechny polozky se zadanym prefixem (napr. "sltv." pri odhlaseni zdroje).
/// Diagnostika: kam se sahne pro data a jestli jde zapsat.
#[tauri::command]
pub fn vault_debug(app: AppHandle) -> Result<serde_json::Value, String> {
    let mut out = serde_json::json!({});
    match app.path().app_data_dir() {
        Ok(d) => {
            out["dir"] = serde_json::Value::String(d.to_string_lossy().into_owned());
            let t = d.join("write-test.tmp");
            out["write"] = serde_json::Value::String(match std::fs::write(&t, b"ok") {
                Ok(_) => {
                    let back = std::fs::read(&t).unwrap_or_default();
                    let _ = std::fs::remove_file(&t);
                    if back == b"ok" {
                        "ok".to_string()
                    } else {
                        "read-mismatch".to_string()
                    }
                }
                Err(e) => format!("ERR: {e}"),
            });
        }
        Err(e) => {
            out["dir_error"] = serde_json::Value::String(e.to_string());
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn vault_clear(app: AppHandle, prefix: String) -> Result<u32, String> {
    let mut map = read_store(&app)?;
    let before = map.len();
    map.retain(|k, _| !k.starts_with(&prefix));
    let removed = (before - map.len()) as u32;
    write_store(&app, &map)?;
    Ok(removed)
}
