use sled::Db;
use std::path::PathBuf;

use super::models::{Bookmark, Preferences, ReadingState};
use chrono::Utc;
use uuid::Uuid;

/// Desktop bookmark format as written by the JS frontend.
/// We deserialise only the fields we need; everything else is preserved on round-trip.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBookmark {
    pub id: serde_json::Value,          // may be number (Date.now()) or string
    pub file_path: Option<String>,
    pub file_name: Option<String>,
    pub book_title: Option<String>,
    pub chapter_index: Option<serde_json::Value>,
    pub chapter_label: Option<String>,
    pub scroll_pct: Option<serde_json::Value>,
    pub label: Option<String>,
    // web-mobile fields written back by us
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_id: Option<String>,         // our UUID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paragraph_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    // preserve any extra fields we don't know about
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

pub struct PersistenceStore {
    pub(crate) db: Db,
    /// Path to the desktop `giano-reader-bookmarks.json` file.
    /// When present, bookmark operations read/write this file as the
    /// single source of truth so desktop and mobile stay in sync.
    desktop_bookmarks_path: PathBuf,
}

impl PersistenceStore {
    /// Opens or creates the sled database at `<app_data_dir>/giano-web.db`.
    ///
    /// Key namespaces used in sled (kept as a fast lookup cache):
    ///   - `reading_state:{book_id}`           → JSON-encoded `ReadingState`
    ///   - `preferences`                        → JSON-encoded `Preferences`
    ///
    /// Bookmarks are stored in the desktop JSON file so both apps share them.
    pub fn open(app_data_dir: PathBuf) -> Result<Self, sled::Error> {
        let path = app_data_dir.join("giano-web.db");
        let db = sled::open(path)?;
        let desktop_bookmarks_path = app_data_dir.join("giano-reader-bookmarks.json");
        Ok(Self { db, desktop_bookmarks_path })
    }

    // ── Reading state ────────────────────────────────────────────────────────

    pub fn get_reading_state(&self, book_id: &str) -> Result<ReadingState, sled::Error> {
        let key = format!("reading_state:{book_id}");
        match self.db.get(key.as_bytes())? {
            Some(bytes) => {
                let state: ReadingState =
                    serde_json::from_slice(&bytes).unwrap_or_default();
                Ok(state)
            }
            None => Ok(ReadingState::default()),
        }
    }

    pub fn put_reading_state(&self, book_id: &str, state: &ReadingState) -> Result<(), sled::Error> {
        let key = format!("reading_state:{book_id}");
        let value = serde_json::to_vec(state).expect("ReadingState serialization should not fail");
        self.db.insert(key.as_bytes(), value)?;
        Ok(())
    }

    // ── Bookmarks — desktop JSON as single source of truth ──────────────────

    /// Reads all bookmarks from the desktop JSON file.
    fn read_desktop_bookmarks(&self) -> Vec<DesktopBookmark> {
        match std::fs::read_to_string(&self.desktop_bookmarks_path) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    }

    /// Writes the bookmark list back to the desktop JSON file atomically
    /// (write to a temp file then rename).
    fn write_desktop_bookmarks(&self, bms: &[DesktopBookmark]) {
        let json = match serde_json::to_string_pretty(bms) {
            Ok(j) => j,
            Err(e) => {
                eprintln!("[persistence] Failed to serialize bookmarks: {}", e);
                return;
            }
        };
        // Write to a temp file in the same directory, then rename for atomicity.
        let tmp = self.desktop_bookmarks_path.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, &json) {
            eprintln!("[persistence] Failed to write tmp bookmark file: {}", e);
            return;
        }
        if let Err(e) = std::fs::rename(&tmp, &self.desktop_bookmarks_path) {
            eprintln!("[persistence] Failed to rename bookmark file: {}", e);
            // Best-effort cleanup
            let _ = std::fs::remove_file(&tmp);
        }
    }

    /// Converts a `DesktopBookmark` to the REST `Bookmark` type.
    /// Uses `web_id` if already set (bookmark created by mobile),
    /// otherwise derives a stable UUID from the desktop numeric id.
    fn to_api_bookmark(bm: &DesktopBookmark) -> Bookmark {
        let id = bm.web_id.clone().unwrap_or_else(|| {
            // Derive a stable UUID-like string from the desktop id so the
            // same desktop bookmark always maps to the same API id.
            let raw = match &bm.id {
                serde_json::Value::Number(n) => n.to_string(),
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            // Prefix with "d-" to distinguish from UUID v4 mobile ids.
            format!("d-{}", raw)
        });

        let chapter_index = match &bm.chapter_index {
            Some(serde_json::Value::Number(n)) => n.as_u64().unwrap_or(0) as u32,
            Some(serde_json::Value::String(s)) => s.parse().unwrap_or(0),
            _ => 0,
        };

        let paragraph_id = bm.paragraph_id.clone().unwrap_or_else(|| {
            // Desktop bookmarks use scrollPct, not paragraphId.
            // Encode it as a synthetic paragraph_id so round-trip is lossless.
            match &bm.scroll_pct {
                Some(serde_json::Value::Number(n)) => format!("scroll:{}", n),
                Some(serde_json::Value::String(s)) => format!("scroll:{}", s),
                _ => "scroll:0".to_string(),
            }
        });

        let label = bm.label.clone().or_else(|| bm.chapter_label.clone());

        let created_at = bm.created_at.clone().unwrap_or_else(|| {
            // Desktop bookmarks use a numeric timestamp as `id`.
            // Convert it to ISO 8601 if possible.
            match &bm.id {
                serde_json::Value::Number(n) => {
                    if let Some(ms) = n.as_i64() {
                        chrono::DateTime::from_timestamp_millis(ms)
                            .map(|dt| dt.to_rfc3339())
                            .unwrap_or_else(|| Utc::now().to_rfc3339())
                    } else {
                        Utc::now().to_rfc3339()
                    }
                }
                _ => Utc::now().to_rfc3339(),
            }
        });

        Bookmark { id, chapter_index, paragraph_id, label, created_at }
    }

    /// Lists all bookmarks for the given book, sorted by chapter_index asc.
    ///
    /// `book_id` is the SHA-256 hash of the canonical epub path.
    /// We match it against the desktop `file_path` field by recomputing the hash.
    pub fn list_bookmarks(&self, book_id: &str) -> Result<Vec<Bookmark>, sled::Error> {
        let all = self.read_desktop_bookmarks();
        let mut matched: Vec<Bookmark> = all
            .iter()
            .filter(|bm| Self::bookmark_matches_book(bm, book_id))
            .map(Self::to_api_bookmark)
            .collect();

        matched.sort_by(|a, b| a.chapter_index.cmp(&b.chapter_index));
        Ok(matched)
    }

    /// Returns true when the desktop bookmark belongs to `book_id`.
    fn bookmark_matches_book(bm: &DesktopBookmark, book_id: &str) -> bool {
        // Mobile bookmarks written back carry the book_id directly.
        if let Some(extra_id) = bm.extra.get("bookId") {
            if let Some(s) = extra_id.as_str() {
                return s == book_id;
            }
        }
        // Desktop bookmarks: derive book_id from file_path and compare.
        if let Some(ref fp) = bm.file_path {
            let path = std::path::Path::new(fp);
            let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
            return super::epub_parser::generate_book_id(&canonical) == book_id;
        }
        false
    }

    /// Creates a new bookmark for the given book in the desktop JSON file.
    pub fn create_bookmark(
        &self,
        book_id: &str,
        chapter_index: u32,
        paragraph_id: &str,
        label: Option<String>,
    ) -> Result<Bookmark, sled::Error> {
        let id = Uuid::new_v4().to_string();
        let created_at = Utc::now().to_rfc3339();

        // Build the desktop bookmark record. We embed the book_id so
        // list_bookmarks can match it back without needing the file_path.
        let mut extra = std::collections::HashMap::new();
        extra.insert(
            "bookId".to_string(),
            serde_json::Value::String(book_id.to_string()),
        );

        let desktop_bm = DesktopBookmark {
            id: serde_json::Value::String(id.clone()),
            file_path: None,
            file_name: None,
            book_title: None,
            chapter_index: Some(serde_json::Value::Number(
                serde_json::Number::from(chapter_index),
            )),
            chapter_label: None,
            scroll_pct: Some(serde_json::Value::Number(serde_json::Number::from(0))),
            label: label.clone(),
            web_id: Some(id.clone()),
            paragraph_id: Some(paragraph_id.to_string()),
            created_at: Some(created_at.clone()),
            extra,
        };

        let mut all = self.read_desktop_bookmarks();
        all.push(desktop_bm);
        self.write_desktop_bookmarks(&all);

        Ok(Bookmark {
            id,
            chapter_index,
            paragraph_id: paragraph_id.to_string(),
            label,
            created_at,
        })
    }

    /// Deletes a bookmark by API id. Returns `true` if it existed, `false` otherwise.
    pub fn delete_bookmark(&self, book_id: &str, bookmark_id: &str) -> Result<bool, sled::Error> {
        let mut all = self.read_desktop_bookmarks();
        let before = all.len();

        all.retain(|bm| {
            // Must belong to this book AND match the given id.
            if !Self::bookmark_matches_book(bm, book_id) {
                return true; // keep — different book
            }
            let api_bm = Self::to_api_bookmark(bm);
            api_bm.id != bookmark_id
        });

        if all.len() == before {
            return Ok(false);
        }

        self.write_desktop_bookmarks(&all);
        Ok(true)
    }

    // ── Preferences ─────────────────────────────────────────────────────────

    pub fn get_preferences(&self) -> Result<Preferences, sled::Error> {
        match self.db.get(b"preferences")? {
            Some(bytes) => {
                let prefs: Preferences =
                    serde_json::from_slice(&bytes).unwrap_or_default();
                Ok(prefs)
            }
            None => Ok(Preferences::default()),
        }
    }

    pub fn put_preferences(&self, prefs: &Preferences) -> Result<(), sled::Error> {
        let json = serde_json::to_vec(prefs).expect("Preferences serialization cannot fail");
        self.db.insert(b"preferences", json)?;
        Ok(())
    }
}
