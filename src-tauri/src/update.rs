use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const MANIFEST_URL: &str =
    "https://minio.cjiw.site/uploads/share/xbot-desktop/tauri/latest.json";

#[derive(Serialize, Deserialize, Clone)]
pub struct UpdateInfo {
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub notes: String,
    pub published_at: String,
}

#[derive(Serialize, Clone)]
pub struct UpdateCheck {
    pub current: String,
    pub available: Option<UpdateInfo>,
}

#[derive(Serialize, Clone)]
struct UpdateProgress {
    downloaded: u64,
    total: u64,
    percent: f64,
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    manifest_url: Option<String>,
) -> Result<UpdateCheck, String> {
    let current = app.package_info().version.clone();
    let current_text = current.to_string();
    let url = manifest_url.unwrap_or_else(|| MANIFEST_URL.to_string());
    validate_https(&url)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("检查更新失败：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("检查更新失败：HTTP {}", response.status().as_u16()));
    }
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取更新清单失败：{e}"))?;
    let info: UpdateInfo =
        serde_json::from_str(&text).map_err(|e| format!("解析更新清单失败：{e}"))?;

    let remote = semver::Version::parse(&info.version)
        .map_err(|e| format!("更新清单版本号无效：{e}"))?;
    let local = semver::Version::parse(&current_text)
        .map_err(|e| format!("当前版本号无效：{e}"))?;
    Ok(UpdateCheck {
        current: current_text,
        available: if remote > local { Some(info) } else { None },
    })
}

#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    info: UpdateInfo,
    url_override: Option<String>,
) -> Result<String, String> {
    let download_url = url_override.unwrap_or_else(|| info.url.clone());
    validate_https(&download_url)?;
    let dir = std::env::temp_dir().join("xbot-tauri-updates");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建更新目录失败：{e}"))?;
    let name = format!("xbot-desktop-tauri-{}-win-x64.exe", info.version);
    let target = dir.join(&name);
    let part = dir.join(format!("{name}.part"));
    if part.exists() {
        let _ = std::fs::remove_file(&part);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;
    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("下载更新失败：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("下载更新失败：HTTP {}", response.status().as_u16()));
    }
    let total = response.content_length().unwrap_or(0);
    let mut downloaded = 0u64;
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|e| format!("创建临时文件失败：{e}"))?;
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断：{e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入更新包失败：{e}"))?;
        downloaded += chunk.len() as u64;
        let percent = if total > 0 {
            (downloaded as f64 / total as f64) * 100.0
        } else {
            0.0
        };
        let _ = app.emit(
            "xbot-update-progress",
            UpdateProgress {
                downloaded,
                total,
                percent,
            },
        );
    }
    file.flush().await.map_err(|e| format!("写入更新包失败：{e}"))?;
    drop(file);

    if !info.sha256.trim().is_empty() {
        let actual = sha256_file(&part).await?;
        if !actual.eq_ignore_ascii_case(info.sha256.trim()) {
            let _ = std::fs::remove_file(&part);
            return Err(format!(
                "更新包校验失败：期望 {}，实际 {}",
                info.sha256, actual
            ));
        }
    }
    if target.exists() {
        let _ = std::fs::remove_file(&target);
    }
    std::fs::rename(&part, &target).map_err(|e| format!("保存更新包失败：{e}"))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn apply_update(app: AppHandle, path: String) -> Result<(), String> {
    let current = std::env::current_exe().map_err(|e| format!("定位当前程序失败：{e}"))?;
    let downloaded = PathBuf::from(&path);
    if !downloaded.is_file() {
        return Err("更新包不存在".into());
    }
    let script = std::env::temp_dir().join(format!("xbot-update-{}.cmd", std::process::id()));
    let content = format!(
        concat!(
            "@echo off\n",
            "setlocal\n",
            "set \"SRC={src}\"\n",
            "set \"DST={dst}\"\n",
            "set /a tries=0\n",
            ":retry\n",
            "copy /Y \"%SRC%\" \"%DST%\" >nul 2>&1\n",
            "if not errorlevel 1 goto done\n",
            "set /a tries+=1\n",
            "if %tries% GEQ 60 goto fail\n",
            "timeout /t 1 /nobreak >nul\n",
            "goto retry\n",
            ":done\n",
            "start \"\" \"%DST%\"\n",
            "del \"%~f0\"\n",
            "exit /b 0\n",
            ":fail\n",
            "del \"%~f0\"\n",
            "exit /b 1\n"
        ),
        src = downloaded.display(),
        dst = current.display()
    );
    std::fs::write(&script, content).map_err(|e| format!("写更新脚本失败：{e}"))?;
    let mut command = std::process::Command::new("cmd.exe");
    command
        .arg("/c")
        .arg(&script)
        .spawn()
        .map_err(|e| format!("启动更新脚本失败：{e}"))?;
    app.exit(0);
    Ok(())
}

async fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("读取更新包失败：{e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    use tokio::io::AsyncReadExt;
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("读取更新包失败：{e}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn validate_https(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("更新地址无效：{e}"))?;
    if parsed.scheme() != "https" {
        return Err("更新地址必须使用 HTTPS".into());
    }
    Ok(())
}
