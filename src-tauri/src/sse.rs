use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

struct Frame {
    id: Option<String>,
    event: String,
    data: String,
}

#[derive(Default)]
struct SseParser {
    id: Option<String>,
    event: String,
    data: String,
}

impl SseParser {
    fn feed(&mut self, line: &str) -> Option<Frame> {
        if line.is_empty() {
            if self.event.is_empty() && self.data.is_empty() && self.id.is_none() {
                return None;
            }
            let frame = Frame {
                id: self.id.take(),
                event: if self.event.is_empty() {
                    "message".to_string()
                } else {
                    std::mem::take(&mut self.event)
                },
                data: std::mem::take(&mut self.data),
            };
            return Some(frame);
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "id" => self.id = Some(value.to_string()),
            "event" => self.event = value.to_string(),
            "data" => {
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data.push_str(value);
            }
            _ => {}
        }
        None
    }
}

pub async fn run(
    app: AppHandle,
    base: String,
    cookie: Option<String>,
    chat_id: String,
    channel: String,
    initial_last_seq: i64,
    token: CancellationToken,
) {
    let client = match reqwest::Client::builder()
        .user_agent("xbot-desktop-tauri/0.1")
        .build()
    {
        Ok(client) => client,
        Err(e) => {
            emit_status(&app, &chat_id, &channel, "error", &format!("创建 HTTP 客户端失败：{e}"));
            return;
        }
    };

    let mut last_seq = initial_last_seq;
    let mut attempt = 0u32;

    loop {
        if token.is_cancelled() {
            break;
        }
        emit_status(&app, &chat_id, &channel, "connecting", "");
        let url = format!(
            "{base}/api/sse?chat_id={}&channel={}",
            urlencoding::encode(&chat_id),
            urlencoding::encode(&channel)
        );
        let mut request = client
            .get(&url)
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .header(reqwest::header::CACHE_CONTROL, "no-cache");
        if let Some(cookie) = &cookie {
            request = request.header(reqwest::header::COOKIE, cookie);
        }
        if last_seq > 0 {
            request = request.header("Last-Event-ID", last_seq.to_string());
        }

        let response = match request.send().await {
            Ok(response) => response,
            Err(e) => {
                if token.is_cancelled() {
                    break;
                }
                emit_status(&app, &chat_id, &channel, "error", &format!("连接失败：{e}"));
                if !sleep_backoff(&token, attempt).await {
                    break;
                }
                attempt += 1;
                continue;
            }
        };

        if !response.status().is_success() {
            emit_status(
                &app,
                &chat_id,
                &channel,
                "error",
                &format!("连接失败：HTTP {}", response.status().as_u16()),
            );
            if !sleep_backoff(&token, attempt).await {
                break;
            }
            attempt += 1;
            continue;
        }

        emit_status(&app, &chat_id, &channel, "connected", "");
        attempt = 0;
        let mut stream = response.bytes_stream();
        let mut parser = SseParser::default();
        let mut buffer = String::new();

        loop {
            if token.is_cancelled() {
                break;
            }
            let next = tokio::time::timeout(Duration::from_secs(45), stream.next()).await;
            let chunk = match next {
                Ok(Some(Ok(chunk))) => chunk,
                Ok(Some(Err(e))) => {
                    emit_status(&app, &chat_id, &channel, "error", &format!("连接中断：{e}"));
                    break;
                }
                Ok(None) => break,
                Err(_) => {
                    emit_status(&app, &chat_id, &channel, "error", "心跳超时");
                    break;
                }
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(position) = buffer.find('\n') {
                let mut line = buffer[..position].to_string();
                buffer.drain(..=position);
                if line.ends_with('\r') {
                    line.pop();
                }
                let Some(frame) = parser.feed(&line) else {
                    continue;
                };

                if let Some(id) = &frame.id {
                    if let Ok(seq) = id.parse::<i64>() {
                        if seq > last_seq {
                            last_seq = seq;
                            // Tag the cursor with the stream that produced it.
                            // The UI persists cursors per chat; without this the
                            // seq of a stream being torn down (session switch)
                            // would be written onto the newly selected chat.
                            let _ = app.emit(
                                "xbot-sse-seq",
                                json!({ "chat_id": chat_id, "channel": channel, "seq": seq }),
                            );
                        }
                    }
                }
                if frame.event == "heartbeat" {
                    log_event(&chat_id, &channel, "heartbeat", "");
                    // Forward liveness to the UI. Heartbeats are the only
                    // traffic on an idle session; without this the connection
                    // indicator has nothing to confirm health with, and a
                    // single missed "connected" status leaves it stuck on
                    // "重连中" until the next real event.
                    let _ = app.emit(
                        "xbot-sse-heartbeat",
                        json!({ "chat_id": chat_id, "channel": channel }),
                    );
                    continue;
                }
                if frame.data.trim().is_empty() || frame.data.trim() == "{}" {
                    continue;
                }

                let mut value: Value = match serde_json::from_str(&frame.data) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                if let Value::Object(map) = &mut value {
                    if !map.contains_key("type") {
                        map.insert("type".to_string(), Value::String(frame.event.clone()));
                    }
                }
                // Every event is stamped with the stream that produced it.
                // Server payloads for progress/stream_content carry no
                // top-level chat_id (only `progress.chat_id`), so the UI
                // cannot otherwise tell an in-flight event from the session
                // being torn down apart from the newly selected one — the
                // exact cause of "A's iterations appearing in B".
                let _ = app.emit(
                    "xbot-sse",
                    json!({
                        "stream_chat_id": chat_id,
                        "stream_channel": channel,
                        "message": value,
                    }),
                );
            }
        }

        if token.is_cancelled() {
            break;
        }
        emit_status(&app, &chat_id, &channel, "error", "连接已关闭");
        if !sleep_backoff(&token, attempt).await {
            break;
        }
        attempt += 1;
    }

    // Cancellation means the session switched / a new stream started. Emitting
    // "disconnected" here would race the new stream's "connected" event and leave
    // the UI stuck on "重连中" even though the new connection is healthy.
    if token.is_cancelled() {
        return;
    }
    emit_status(&app, &chat_id, &channel, "disconnected", "");
}

fn emit_status(app: &AppHandle, chat_id: &str, channel: &str, state: &str, message: &str) {
    log_event(chat_id, channel, state, message);
    let _ = app.emit(
        "xbot-sse-status",
        json!({
            "state": state,
            "message": message,
            // Which stream this status belongs to. A torn-down stream must not
            // flip the connection indicator of the session the user just
            // switched to.
            "chat_id": chat_id,
            "channel": channel,
        }),
    );
}

/// Append an SSE lifecycle line to `%TEMP%\xbot-sse.log`, keeping it small.
/// Connection flapping is invisible from the UI once it recovers, so this log
/// is the only way to tell "the server dropped us" apart from "the indicator
/// was stale".
fn log_event(chat_id: &str, channel: &str, event: &str, detail: &str) {
    use std::io::Write;
    let path = std::env::temp_dir().join("xbot-sse.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 512 * 1024 {
            let _ = std::fs::remove_file(&path);
        }
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_millis())
            .unwrap_or(0);
        let _ = writeln!(file, "{ts} {chat_id} {channel} {event} {detail}");
    }
}

async fn sleep_backoff(token: &CancellationToken, attempt: u32) -> bool {
    let seconds = std::cmp::min(30, 1u64 << attempt.min(5));
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs(seconds)) => true,
        _ = token.cancelled() => false,
    }
}
