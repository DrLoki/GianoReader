use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

// ── REST response shapes ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookSummary {
    pub id: String,
    pub title: String,
    pub author: String,
    pub cover_url: Option<String>, // "/api/books/{id}/cover" or null
    pub progress: u8,              // 0–100
    pub status: Option<String>,    // "to-read" | "reading" | "read" | null
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TocEntry {
    pub index: u32,
    pub title: String,
    pub href: String,
    pub level: u32,
    pub spine_index: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterResponse {
    pub chapter_index: u32,
    pub title: String,
    pub paragraphs: Vec<Paragraph>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paragraph {
    pub id: String,    // stable hex hash
    pub index: u32,
    pub html: String,  // sanitised inner HTML (em/strong/a/span only)
    pub text: String,  // plain text, all tags stripped
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>, // original EPUB id attribute from the block-level tag
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingState {
    pub current_chapter: u32,
    pub paragraph_id: Option<String>,
    pub scroll_offset: f64, // non-negative
    pub progress: u8,       // 0–100
}

impl Default for ReadingState {
    fn default() -> Self {
        Self {
            current_chapter: 0,
            paragraph_id: None,
            scroll_offset: 0.0,
            progress: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,            // server-generated UUID v4
    pub chapter_index: u32,
    pub paragraph_id: String,
    pub label: Option<String>, // max 200 chars
    pub created_at: String,    // ISO 8601 UTC
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub theme: String,            // "light" | "dark" | "sepia"
    pub ui_language: String,      // "it" | "en"
    pub translation_lang: String, // one of the 12 BCP-47 codes
    pub font_size: u8,            // 12–32
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcloud_project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcloud_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcloud_model: Option<String>, // "nmt" | "tllm"
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            ui_language: "en".into(),
            translation_lang: "it".into(),
            font_size: 16,
            gcloud_project_id: None,
            gcloud_api_key: None,
            gcloud_model: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerInfo {
    pub port: u16,
    pub lan_url: String,
    pub qr_url: String,
}

// ── Runtime state (not serialized) ──────────────────────────────────────────

/// Holds the live server lifecycle handles. Not serialized — runtime only.
pub struct ServerHandle {
    pub shutdown_tx: CancellationToken,
    pub server_task: tokio::task::JoinHandle<()>,
    pub port: u16,
    pub lan_ip: Option<std::net::Ipv4Addr>,
}

/// Tauri-managed state wrapping the optional live server handle.
pub struct ServerState {
    pub handle: Arc<Mutex<Option<ServerHandle>>>,
}
