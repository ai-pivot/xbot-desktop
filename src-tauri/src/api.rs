use crate::state::{normalize_base_url, AppState};
use base64::Engine;
use reqwest::header::{ACCEPT, COOKIE};
use serde_json::{json, Value};
use std::path::Path;
use tauri::State;
use tokio_util::sync::CancellationToken;

async fn call(
    state: &AppState,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let base = state.base();
    if base.is_empty() {
        return Err("请先配置服务器地址".into());
    }
    let url = format!("{base}{path}");
    // Transport failures are usually transient (DNS/TUN/proxy not ready right
    // after boot or a network switch). Retry only requests that are safe to
    // repeat: reads and auth. A retried `send` would duplicate a user message.
    let retryable = method == reqwest::Method::GET || path.starts_with("/api/auth/");
    let attempts = if retryable { 3 } else { 1 };
    let mut last_error: Option<reqwest::Error> = None;
    let mut response: Option<reqwest::Response> = None;
    for attempt in 0..attempts {
        let mut request = state
            .http
            .request(method.clone(), &url)
            .header(ACCEPT, "application/json");
        if let Some(cookie) = state.cookie_header() {
            request = request.header(COOKIE, cookie);
        }
        if let Some(body) = &body {
            request = request.json(body);
        }
        match request.send().await {
            Ok(value) => {
                response = Some(value);
                break;
            }
            Err(error) => {
                last_error = Some(error);
                if attempt + 1 < attempts {
                    tokio::time::sleep(std::time::Duration::from_millis(300 * (1 << attempt))).await;
                }
            }
        }
    }
    let response = match response {
        Some(value) => value,
        None => {
            let message = match last_error {
                Some(error) => transport_message(&error),
                None => "网络请求失败：未知错误".to_string(),
            };
            return Err(message);
        }
    };
    state.capture(response.headers());
    state.save();

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);

    if !status.is_success() {
        return Err(error_text(&value, &text, status.as_u16()));
    }
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(error_text(&value, &text, status.as_u16()));
    }
    Ok(value.get("data").cloned().unwrap_or(value))
}

/// reqwest's Display only says "error sending request for url (...)"; the real
/// reason (DNS failure, connection refused, TLS error, timeout) is in the
/// source chain. Surface it so the login error is actionable.
fn transport_message(error: &reqwest::Error) -> String {
    let mut text = format!("网络请求失败：{error}");
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        let detail = cause.to_string();
        if !text.contains(&detail) {
            text.push_str("（");
            text.push_str(&detail);
            text.push('）');
        }
        source = cause.source();
    }
    text
}

fn error_text(value: &Value, raw: &str, status: u16) -> String {
    if let Some(message) = value.pointer("/error/message").and_then(Value::as_str) {
        return message.to_string();
    }
    if raw.trim().is_empty() {
        format!("请求失败（HTTP {status}）")
    } else {
        format!("请求失败（HTTP {status}）：{raw}")
    }
}

pub async fn post(state: &AppState, path: &str, body: Value) -> Result<Value, String> {
    call(state, reqwest::Method::POST, path, Some(body)).await
}

#[tauri::command]
pub async fn configure_server(state: State<'_, AppState>, url: String) -> Result<(), String> {
    state.set_server(&normalize_base_url(&url));
    Ok(())
}

#[tauri::command]
pub async fn auth_config(state: State<'_, AppState>) -> Result<Value, String> {
    post(&state, "/api/auth/config", json!({})).await
}

#[tauri::command]
pub async fn login(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<Value, String> {
    let result = post(
        &state,
        "/api/auth/login",
        json!({ "username": username.trim(), "password": password }),
    )
    .await?;
    state.save();
    Ok(result)
}

#[tauri::command]
pub async fn register(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<Value, String> {
    post(
        &state,
        "/api/auth/register",
        json!({ "username": username.trim(), "password": password }),
    )
    .await?;
    let result = post(
        &state,
        "/api/auth/login",
        json!({ "username": username.trim(), "password": password }),
    )
    .await?;
    state.save();
    Ok(result)
}

#[tauri::command]
pub async fn logout(state: State<'_, AppState>) -> Result<(), String> {
    let _ = post(&state, "/api/auth/logout", json!({})).await;
    state.clear_cookies();
    Ok(())
}

#[tauri::command]
pub async fn has_session(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.cookie_header().is_some())
}

#[tauri::command]
pub async fn try_resume(state: State<'_, AppState>) -> Result<Value, String> {
    post(&state, "/api/session-tree", json!({})).await
}

#[tauri::command]
pub async fn session_tree(state: State<'_, AppState>) -> Result<Value, String> {
    post(&state, "/api/session-tree", json!({})).await
}

#[tauri::command]
pub async fn history(
    state: State<'_, AppState>,
    chat_id: String,
    channel: String,
    limit: Option<i64>,
    before_id: Option<i64>,
) -> Result<Value, String> {
    post(
        &state,
        "/api/history",
        json!({
            "chat_id": chat_id,
            "channel": channel,
            "limit": limit.unwrap_or(40),
            "before_id": before_id.unwrap_or(0),
        }),
    )
    .await
}

#[tauri::command]
pub async fn rewind_history(
    state: State<'_, AppState>,
    chat_id: String,
    channel: String,
    history_id: i64,
) -> Result<Value, String> {
    // Truncates the session at this user message and returns its content as
    // `draft` so the UI can put it back into the composer (edit/rewind).
    post(
        &state,
        "/api/history/rewind",
        json!({
            "chat_id": chat_id,
            "channel": channel,
            "history_id": history_id,
        }),
    )
    .await
}

#[tauri::command]
pub async fn send_message(state: State<'_, AppState>, request: Value) -> Result<Value, String> {
    post(&state, "/api/message", request).await
}

#[tauri::command]
pub async fn cancel(
    state: State<'_, AppState>,
    chat_id: String,
    channel: String,
) -> Result<Value, String> {
    post(
        &state,
        "/api/cancel",
        json!({ "chat_id": chat_id, "channel": channel }),
    )
    .await
}

#[tauri::command]
pub async fn cancel_queued(
    state: State<'_, AppState>,
    chat_id: String,
    channel: String,
    msg_id: String,
) -> Result<Value, String> {
    post(
        &state,
        "/api/queue/cancel",
        json!({ "chat_id": chat_id, "channel": channel, "msg_id": msg_id }),
    )
    .await
}

#[tauri::command]
pub async fn respond_ask_user(
    state: State<'_, AppState>,
    chat_id: String,
    channel: String,
    answers: Value,
    cancelled: bool,
) -> Result<Value, String> {
    post(
        &state,
        "/api/ask_user/respond",
        json!({
            "chat_id": chat_id,
            "channel": channel,
            "answers": answers,
            "cancelled": cancelled,
        }),
    )
    .await
}

#[tauri::command]
pub async fn session_status(
    state: State<'_, AppState>,
    chat_id: String,
    channel: String,
) -> Result<Value, String> {
    post(
        &state,
        "/api/session/status",
        json!({ "chat_id": chat_id, "channel": channel }),
    )
    .await
}

#[tauri::command]
pub async fn rpc(
    state: State<'_, AppState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    post(
        &state,
        "/api/rpc",
        json!({ "method": method, "params": params.unwrap_or_else(|| json!({})) }),
    )
    .await
}

#[tauri::command]
pub async fn upload_file(state: State<'_, AppState>, path: String) -> Result<Value, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败：{e}"))?;
    let name = Path::new(&path)
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("file")
        .to_string();
    let mime = guess_mime(&name);
    upload_part(&state, name, mime, bytes).await
}

/// Paste/drag upload from the WebView: the browser only has the bytes, not a
/// filesystem path. base64 keeps the IPC payload a string (no huge JSON number
/// arrays) while still supporting arbitrary file types.
#[tauri::command]
pub async fn upload_bytes(
    state: State<'_, AppState>,
    name: String,
    mime: String,
    data_base64: String,
) -> Result<Value, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("粘贴文件解码失败：{e}"))?;
    let mime = if mime.trim().is_empty() { guess_mime(&name) } else { mime };
    upload_part(&state, name, mime, bytes).await
}

async fn upload_part(
    state: &AppState,
    name: String,
    mime: String,
    bytes: Vec<u8>,
) -> Result<Value, String> {
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(name)
        .mime_str(&mime)
        .map_err(|e| format!("文件类型错误：{e}"))?;
    let form = reqwest::multipart::Form::new().part("file", part);

    let base = state.base();
    if base.is_empty() {
        return Err("请先配置服务器地址".into());
    }
    let mut request = state
        .http
        .post(format!("{base}/api/files/upload"))
        .multipart(form)
        .header(ACCEPT, "application/json");
    if let Some(cookie) = state.cookie_header() {
        request = request.header(COOKIE, cookie);
    }
    let response = request.send().await.map_err(|e| format!("上传失败：{e}"))?;
    state.capture(response.headers());
    state.save();
    let status = response.status();
    let text = response.text().await.map_err(|e| format!("读取响应失败：{e}"))?;
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !status.is_success() || value.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(error_text(&value, &text, status.as_u16()));
    }
    Ok(value.get("data").cloned().unwrap_or(value))
}

#[tauri::command]
pub async fn pick_file() -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .pick_file()
            .map(|path| path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("打开文件选择器失败：{e}"))?;
    Ok(picked)
}

#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:")) {
        return Err("不支持的链接协议".into());
    }
    open::that(url).map_err(|e| format!("打开链接失败：{e}"))
}

fn guess_mime(name: &str) -> String {
    match Path::new(name)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[tauri::command]
pub async fn start_sse(
    state: State<'_, AppState>,
    chat_id: String,
    channel: String,
    last_seq: i64,
    epoch: u64,
) -> Result<(), String> {
    let base = state.base();
    if base.is_empty() {
        return Err("请先配置服务器地址".into());
    }
    // Reject a stale generation: the UI may have switched sessions while this
    // invocation was queued. The newer stream must win regardless of the order
    // in which the Rust side happens to run the two commands.
    {
        let mut guard = state.sse_epoch.lock().map_err(|e| e.to_string())?;
        if epoch < *guard {
            return Ok(());
        }
        *guard = epoch;
    }
    let token = CancellationToken::new();
    {
        let mut guard = state.sse.lock().map_err(|e| e.to_string())?;
        if let Some(old) = guard.take() {
            old.cancel();
        }
        *guard = Some(token.clone());
    }
    let app = state.app.clone();
    let cookie = state.cookie_header();
    tauri::async_runtime::spawn(async move {
        crate::sse::run(app, base, cookie, chat_id, channel, last_seq, token).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn stop_sse(state: State<'_, AppState>) -> Result<(), String> {
    if let Ok(mut guard) = state.sse.lock() {
        if let Some(token) = guard.take() {
            token.cancel();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn create_chat(state: State<'_, AppState>, label: String) -> Result<Value, String> {
    post(&state, "/api/chats/create", json!({ "label": label })).await
}

#[tauri::command]
pub async fn rename_chat(
    state: State<'_, AppState>,
    chat_id: String,
    channel: String,
    label: String,
) -> Result<Value, String> {
    let path = format!(
        "/api/chats/{}/rename?channel={}",
        urlencoding::encode(&chat_id),
        urlencoding::encode(&channel)
    );
    post(&state, &path, json!({ "label": label })).await
}

#[tauri::command]
pub async fn delete_chat(
    state: State<'_, AppState>,
    chat_id: String,
    channel: String,
) -> Result<Value, String> {
    let path = format!("/api/chats/{}/delete", urlencoding::encode(&chat_id));
    post(&state, &path, json!({ "channel": channel })).await
}

#[tauri::command]
pub async fn fork_chat(
    state: State<'_, AppState>,
    source_chat_id: String,
    source_channel: String,
    label: String,
) -> Result<Value, String> {
    post(
        &state,
        "/api/chats/fork",
        json!({
            "source_chat_id": source_chat_id,
            "source_channel": source_channel,
            "label": label,
        }),
    )
    .await
}

#[tauri::command]
pub async fn fs_list(
    state: State<'_, AppState>,
    path: String,
    show_hidden: Option<bool>,
) -> Result<Value, String> {
    post(
        &state,
        "/api/fs/list",
        json!({ "path": path, "show_hidden": show_hidden.unwrap_or(false) }),
    )
    .await
}
