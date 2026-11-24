use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ORIGIN: &str = "https://tv.vodafone.cz";
const REFERER: &str = "https://tv.vodafone.cz/";

/// Povoli jen HTTPS volani na domeny Vodafone TV / Kaltura / Nagra.
fn is_allowed_vodafone_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split('/').next().unwrap_or("").to_ascii_lowercase();
    host == "tv.vodafone.cz"
        || host.ends_with(".vodafone.com")
        || host.ends_with(".ott.kaltura.com")
        || host.ends_with(".anycast.nagra.com")
}

/// CORS-free POST pro Vodafone TV APIGW / Phoenix / SSM s podporou DAS hlavicek
/// (`vtv-authentication`, `vtv-id`, `vtv-authorization`).
#[tauri::command]
pub async fn vodafone_post(
    url: String,
    body: String,
    headers: Option<BTreeMap<String, String>>,
) -> Result<Value, String> {
    if !is_allowed_vodafone_url(&url) {
        return Err("vodafone_post: nepovolena URL".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client
        .post(&url)
        .header(reqwest::header::USER_AGENT, UA)
        .header(reqwest::header::ORIGIN, ORIGIN)
        .header(reqwest::header::REFERER, REFERER)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body);
    if let Some(hdrs) = headers {
        for (k, v) in hdrs {
            req = req.header(k, v);
        }
    }
    let res = req.send().await.map_err(|e| format!("vodafone http: {e}"))?;
    let status = res.status().as_u16();
    let mut resp_headers = BTreeMap::new();
    for (k, v) in res.headers() {
        if let Ok(val) = v.to_str() {
            resp_headers.insert(k.as_str().to_ascii_lowercase(), val.to_string());
        }
    }
    let text = res.text().await.map_err(|e| format!("vodafone body: {e}"))?;
    let parsed: Value = serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text));
    Ok(json!({ "status": status, "headers": resp_headers, "body": parsed }))
}

/// Stahne binarni odpoved (napr. Widevine server certifikat z Nagra SSP) a vrati base64.
#[tauri::command]
pub async fn vodafone_get_b64(url: String) -> Result<String, String> {
    if !is_allowed_vodafone_url(&url) {
        return Err("vodafone_get_b64: nepovolena URL".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, UA)
        .header(reqwest::header::ORIGIN, ORIGIN)
        .header(reqwest::header::REFERER, REFERER)
        .send()
        .await
        .map_err(|e| format!("vodafone cert: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("vodafone cert HTTP {}", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| format!("vodafone cert body: {e}"))?;
    Ok(B64.encode(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_vodafone_kaltura_nagra_https_only() {
        assert!(is_allowed_vodafone_url("https://tv.vodafone.cz/init.xml"));
        assert!(is_allowed_vodafone_url("https://apigw.cz.vtv.vodafone.com/vtv/authentication/v2/credentials"));
        assert!(is_allowed_vodafone_url("https://3062.dms-vfp2.ott.kaltura.com/getconfig"));
        assert!(is_allowed_vodafone_url("https://vdcr01h5.anycast.nagra.com/VDCR01H5/wvls/contentlicenseservice/v1/certificates"));
        assert!(!is_allowed_vodafone_url("http://apigw.cz.vtv.vodafone.com/vtv/"));
        assert!(!is_allowed_vodafone_url("https://evil.example.com/vtv"));
        assert!(!is_allowed_vodafone_url("https://vodafone.com.evil.org/vtv"));
    }
}
