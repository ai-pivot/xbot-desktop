use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct CookieJar {
    pub server: String,
    pub cookies: HashMap<String, String>,
}

impl CookieJar {
    pub fn header(&self) -> Option<String> {
        if self.cookies.is_empty() {
            return None;
        }
        let mut parts: Vec<String> = self
            .cookies
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        parts.sort();
        Some(parts.join("; "))
    }

    pub fn capture(&mut self, headers: &reqwest::header::HeaderMap) {
        for value in headers.get_all(reqwest::header::SET_COOKIE).iter() {
            let Ok(raw) = value.to_str() else { continue };
            let first = raw.split(';').next().unwrap_or("").trim();
            let Some((name, val)) = first.split_once('=') else { continue };
            let name = name.trim();
            if name.is_empty() {
                continue;
            }
            if val.is_empty() {
                self.cookies.remove(name);
            } else {
                self.cookies.insert(name.to_string(), val.trim().to_string());
            }
        }
    }
}

pub struct AppState {
    pub base_url: RwLock<String>,
    pub cookies: Mutex<CookieJar>,
    pub http: reqwest::Client,
    pub sse: Mutex<Option<CancellationToken>>,
    /// Monotonic session-generation counter owned by the UI. A `start_sse`
    /// call carrying an older generation is ignored, so an in-flight request
    /// from a session the user already left can never replace the live
    /// stream of the session they switched to.
    pub sse_epoch: Mutex<u64>,
    pub app: AppHandle,
    pub dir: PathBuf,
}

impl AppState {
    pub fn new(app: AppHandle) -> Self {
        let dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("session.json");
        let jar = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<CookieJar>(&s).ok())
            .unwrap_or_default();
        let base_url = jar.server.clone();
        let http = reqwest::Client::builder()
            .user_agent("xbot-desktop-tauri/0.1")
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("failed to build http client");
        Self {
            base_url: RwLock::new(base_url),
            cookies: Mutex::new(jar),
            http,
            sse: Mutex::new(None),
            sse_epoch: Mutex::new(0),
            app,
            dir,
        }
    }

    pub fn base(&self) -> String {
        self.base_url.read().map(|v| v.clone()).unwrap_or_default()
    }

    pub fn set_server(&self, url: &str) {
        let normalized = normalize_base_url(url);
        {
            let mut base = self.base_url.write().unwrap();
            *base = normalized.clone();
        }
        {
            let mut jar = self.cookies.lock().unwrap();
            if jar.server != normalized {
                jar.cookies.clear();
                jar.server = normalized;
            }
        }
        self.save();
    }

    pub fn cookie_header(&self) -> Option<String> {
        self.cookies.lock().ok().and_then(|jar| jar.header())
    }

    pub fn capture(&self, headers: &reqwest::header::HeaderMap) {
        if let Ok(mut jar) = self.cookies.lock() {
            jar.capture(headers);
        }
    }

    pub fn clear_cookies(&self) {
        if let Ok(mut jar) = self.cookies.lock() {
            jar.cookies.clear();
            jar.server = self.base();
        }
        self.save();
    }

    pub fn save(&self) {
        let jar = match self.cookies.lock() {
            Ok(jar) => jar.clone(),
            Err(_) => return,
        };
        if let Ok(text) = serde_json::to_string_pretty(&jar) {
            let _ = std::fs::write(self.dir.join("session.json"), text);
        }
    }
}

pub fn normalize_base_url(raw: &str) -> String {
    let mut value = raw.trim().trim_end_matches('/').to_string();
    if value.is_empty() {
        return value;
    }
    if !value.starts_with("http://") && !value.starts_with("https://") {
        value = format!("http://{value}");
    }
    value
}
