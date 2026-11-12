//! Book rating (1–5 stars) stored in the desktop `giano-reader-library.json`.
//!
//! The library file has two writers: the desktop UI and this server (ratings
//! set from the phone PWA). The server only touches `rating` and
//! `ratingUpdatedAt` on the matching entry and keeps every other field as is.
//! The desktop merges ratings from disk by `ratingUpdatedAt` before each save
//! (`library-sync.js`), so a rating set from the phone is not lost.

use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Deserializer};
use serde_json::Value;

use super::epub_parser::generate_book_id;

pub const MIN_RATING: u8 = 1;
pub const MAX_RATING: u8 = 5;

/// Returns `Some(n)` only for an integer rating in 1..=5.
pub fn normalize_rating(value: &Value) -> Option<u8> {
    let n = value.as_u64()?;
    if (MIN_RATING as u64..=MAX_RATING as u64).contains(&n) {
        Some(n as u8)
    } else {
        None
    }
}

/// Lenient serde helper: a missing, null or invalid rating becomes `None`
/// instead of failing the whole library parse.
pub fn deserialize_rating<'de, D>(deserializer: D) -> Result<Option<u8>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(value.as_ref().and_then(normalize_rating))
}

#[derive(Debug, PartialEq, Eq)]
pub enum RatingError {
    /// No library entry matches the book id (or the library file is missing).
    NotFound,
    /// The library file exists but could not be read or parsed. Nothing is
    /// written, so a half-written desktop save is never overwritten.
    Unavailable(String),
}

/// Serialises read-modify-write cycles on the library file.
fn library_lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Path of the desktop library JSON, next to the `library` folder.
pub fn library_json_path(library_path: &Path) -> std::path::PathBuf {
    library_path
        .parent()
        .unwrap_or(library_path)
        .join("giano-reader-library.json")
}

fn entry_matches(entry: &Value, book_id: &str) -> bool {
    let Some(file_path) = entry.get("filePath").and_then(Value::as_str) else {
        return false;
    };
    let path = Path::new(file_path);
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    generate_book_id(&canonical) == book_id
}

/// Sets (or clears, with `None`) the rating of the library entry for `book_id`.
/// Returns the stored rating.
pub fn set_book_rating(
    library_path: &Path,
    book_id: &str,
    rating: Option<u8>,
) -> Result<Option<u8>, RatingError> {
    let json_path = library_json_path(library_path);
    let _guard = library_lock().lock().unwrap_or_else(|e| e.into_inner());

    if !json_path.exists() {
        return Err(RatingError::NotFound);
    }
    let content = fs::read_to_string(&json_path)
        .map_err(|e| RatingError::Unavailable(format!("cannot read library: {e}")))?;
    let mut entries: Vec<Value> = serde_json::from_str(&content)
        .map_err(|e| RatingError::Unavailable(format!("cannot parse library: {e}")))?;

    let entry = entries
        .iter_mut()
        .find(|e| entry_matches(e, book_id))
        .ok_or(RatingError::NotFound)?;
    let obj = entry
        .as_object_mut()
        .ok_or_else(|| RatingError::Unavailable("library entry is not an object".into()))?;
    obj.insert(
        "rating".into(),
        rating.map(Value::from).unwrap_or(Value::Null),
    );
    obj.insert("ratingUpdatedAt".into(), Value::from(now_millis()));

    // Same format as the desktop (`JSON.stringify(value, null, 2)`).
    let json = serde_json::to_string_pretty(&entries)
        .map_err(|e| RatingError::Unavailable(format!("cannot serialise library: {e}")))?;
    // Write to a temp file in the same directory, then rename for atomicity.
    let tmp = json_path.with_extension("json.tmp");
    fs::write(&tmp, json)
        .map_err(|e| RatingError::Unavailable(format!("cannot write library: {e}")))?;
    fs::rename(&tmp, &json_path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        RatingError::Unavailable(format!("cannot replace library: {e}"))
    })?;
    Ok(rating)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    /// Creates `<tmp>/<name>/library` plus one EPUB-named file per entry and a
    /// library JSON listing them. Returns (library dir, book paths).
    fn setup(name: &str, extra: Value) -> (PathBuf, Vec<PathBuf>) {
        let root = std::env::temp_dir().join(format!("giano-rating-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let library = root.join("library");
        fs::create_dir_all(&library).unwrap();
        let a = root.join("a.epub");
        let b = root.join("b.epub");
        fs::write(&a, b"x").unwrap();
        fs::write(&b, b"x").unwrap();
        let entries = json!([
            { "id": "1", "filePath": a.to_string_lossy(), "title": "A", "notes": "keep me", "extra": extra },
            { "id": "2", "filePath": b.to_string_lossy(), "title": "B", "rating": 2 }
        ]);
        fs::write(root.join("giano-reader-library.json"), entries.to_string()).unwrap();
        (library, vec![a, b])
    }

    fn id_of(path: &Path) -> String {
        generate_book_id(&path.canonicalize().unwrap())
    }

    fn read_entries(library: &Path) -> Vec<Value> {
        serde_json::from_str(&fs::read_to_string(library_json_path(library)).unwrap()).unwrap()
    }

    #[test]
    fn normalize_accepts_only_integers_1_to_5() {
        for n in 1..=5 {
            assert_eq!(normalize_rating(&json!(n)), Some(n as u8));
        }
        for v in [json!(0), json!(6), json!(-1), json!(3.5), json!("4"), json!(null)] {
            assert_eq!(normalize_rating(&v), None, "{v}");
        }
    }

    #[test]
    fn sets_rating_and_keeps_other_fields() {
        let (library, books) = setup("set", json!({ "nested": [1, 2] }));
        let stored = set_book_rating(&library, &id_of(&books[0]), Some(4)).unwrap();
        assert_eq!(stored, Some(4));

        let entries = read_entries(&library);
        assert_eq!(entries[0]["rating"], json!(4));
        assert!(entries[0]["ratingUpdatedAt"].as_u64().unwrap() > 0);
        assert_eq!(entries[0]["notes"], json!("keep me"));
        assert_eq!(entries[0]["extra"], json!({ "nested": [1, 2] }));
        assert_eq!(entries[0]["id"], json!("1"));
        // The other entry is untouched
        assert_eq!(entries[1]["rating"], json!(2));
        assert!(entries[1].get("ratingUpdatedAt").is_none());
    }

    #[test]
    fn clears_rating_with_none() {
        let (library, books) = setup("clear", json!(null));
        set_book_rating(&library, &id_of(&books[1]), None).unwrap();
        assert_eq!(read_entries(&library)[1]["rating"], Value::Null);
    }

    #[test]
    fn unknown_book_is_not_found() {
        let (library, _) = setup("unknown", json!(null));
        assert_eq!(
            set_book_rating(&library, "0000000000000000", Some(3)),
            Err(RatingError::NotFound)
        );
    }

    #[test]
    fn corrupt_library_is_left_untouched() {
        let (library, books) = setup("corrupt", json!(null));
        let path = library_json_path(&library);
        fs::write(&path, "[{ \"filePath\": ").unwrap();
        let result = set_book_rating(&library, &id_of(&books[0]), Some(5));
        assert!(matches!(result, Err(RatingError::Unavailable(_))));
        assert_eq!(fs::read_to_string(&path).unwrap(), "[{ \"filePath\": ");
    }
}
