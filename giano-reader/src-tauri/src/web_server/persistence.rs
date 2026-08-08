use sled::Db;
use std::path::PathBuf;

use super::models::{Bookmark, Preferences, ReadingState};
use chrono::Utc;
use uuid::Uuid;

pub struct PersistenceStore {
    pub(crate) db: Db,
}

impl PersistenceStore {
    /// Opens or creates the sled database at `<app_data_dir>/giano-web.db`.
    ///
    /// Key namespaces used:
    ///   - `reading_state:{book_id}`           → JSON-encoded `ReadingState`
    ///   - `bookmarks:{book_id}:{bookmark_id}` → JSON-encoded `Bookmark`
    ///   - `preferences`                        → JSON-encoded `Preferences`
    pub fn open(app_data_dir: PathBuf) -> Result<Self, sled::Error> {
        let path = app_data_dir.join("giano-web.db");
        let db = sled::open(path)?;
        Ok(Self { db })
    }

    /// Retrieves the reading state for the given book.
    /// Returns `ReadingState::default()` if no entry exists for the book.
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

    /// Persists the reading state for the given book.
    pub fn put_reading_state(&self, book_id: &str, state: &ReadingState) -> Result<(), sled::Error> {
        let key = format!("reading_state:{book_id}");
        let value = serde_json::to_vec(state).expect("ReadingState serialization should not fail");
        self.db.insert(key.as_bytes(), value)?;
        Ok(())
    }

    /// Lists all bookmarks for the given book, sorted by chapter_index ascending,
    /// then by paragraph_id numerically ascending.
    pub fn list_bookmarks(&self, book_id: &str) -> Result<Vec<Bookmark>, sled::Error> {
        let prefix = format!("bookmarks:{book_id}:");
        let mut bookmarks: Vec<Bookmark> = self
            .db
            .scan_prefix(prefix.as_bytes())
            .filter_map(|item| {
                let (_key, value) = item.ok()?;
                serde_json::from_slice::<Bookmark>(&value).ok()
            })
            .collect();

        bookmarks.sort_by(|a, b| {
            a.chapter_index.cmp(&b.chapter_index).then_with(|| {
                let a_num = a.paragraph_id.parse::<u64>().unwrap_or(u64::MAX);
                let b_num = b.paragraph_id.parse::<u64>().unwrap_or(u64::MAX);
                a_num.cmp(&b_num)
            })
        });

        Ok(bookmarks)
    }

    /// Creates a new bookmark for the given book.
    /// Generates a UUID v4 id and records the current UTC time as ISO 8601.
    pub fn create_bookmark(
        &self,
        book_id: &str,
        chapter_index: u32,
        paragraph_id: &str,
        label: Option<String>,
    ) -> Result<Bookmark, sled::Error> {
        let id = Uuid::new_v4().to_string();
        let created_at = Utc::now().to_rfc3339();

        let bookmark = Bookmark {
            id: id.clone(),
            chapter_index,
            paragraph_id: paragraph_id.to_string(),
            label,
            created_at,
        };

        let key = format!("bookmarks:{book_id}:{id}");
        let value = serde_json::to_vec(&bookmark).expect("Bookmark serialization should not fail");
        self.db.insert(key.as_bytes(), value)?;

        Ok(bookmark)
    }

    /// Deletes a bookmark by id. Returns `true` if the bookmark existed, `false` otherwise.
    pub fn delete_bookmark(&self, book_id: &str, bookmark_id: &str) -> Result<bool, sled::Error> {
        let key = format!("bookmarks:{book_id}:{bookmark_id}");
        let prev = self.db.remove(key.as_bytes())?;
        Ok(prev.is_some())
    }

    /// Returns the stored user preferences, or `Preferences::default()` when the key is absent.
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

    /// Persists the given preferences as JSON under the `preferences` key.
    pub fn put_preferences(&self, prefs: &Preferences) -> Result<(), sled::Error> {
        let json = serde_json::to_vec(prefs).expect("Preferences serialization cannot fail");
        self.db.insert(b"preferences", json)?;
        Ok(())
    }
}
