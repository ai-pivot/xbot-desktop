use std::io::Write;
use std::path::PathBuf;

/// One log file for the whole client: JS errors, IPC failures and SSE
/// lifecycle all land here so "看不到日志" is never a dead end.
pub fn log_path() -> PathBuf {
    std::env::temp_dir().join("xbot-desktop.log")
}

const MAX_BYTES: u64 = 2 * 1024 * 1024;

pub fn append(scope: &str, message: &str, detail: &str) {
    let path = log_path();
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > MAX_BYTES {
            let _ = std::fs::remove_file(&path);
        }
    }
    let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let detail = detail.replace('\n', "\\n");
    let _ = writeln!(file, "{ts} [{scope}] {message} {detail}");
}

#[tauri::command]
pub fn append_log(scope: String, message: String, detail: Option<String>) {
    append(&scope, &message, detail.as_deref().unwrap_or(""));
}

#[tauri::command]
pub fn open_log() -> Result<String, String> {
    let path = log_path();
    if !path.exists() {
        let _ = std::fs::write(&path, "");
    }
    // Best effort: put the path on the clipboard-like stdout as well, so the
    // UI can show it even when the OS refuses to open the file.
    open::that(&path).map_err(|e| format!("打开日志失败：{e}"))?;
    Ok(path.to_string_lossy().to_string())
}
