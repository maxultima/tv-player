fn main() {
    println!(
        "cargo:rustc-env=BUILD_TIME={}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    );
    tauri_build::build()
}
