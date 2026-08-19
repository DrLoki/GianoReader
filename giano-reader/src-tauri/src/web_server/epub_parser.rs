use std::fs;
use std::path::{Path, PathBuf};

use epub::doc::EpubDoc;
use sha2::{Digest, Sha256};

use super::models::{BookSummary, ChapterResponse, Paragraph, TocEntry};
use super::persistence::PersistenceStore;

/// Scans `library_path` for `.epub` files and returns a summary for each one.
/// First checks for a `giano-reader-library.json` file (desktop app library) in
/// the parent directory and uses those file paths. Falls back to scanning the
/// directory for `.epub` files.
/// Skips unreadable files with a warning. Returns an empty vec if no books are found.
pub fn list_books(library_path: &Path, store: &PersistenceStore) -> Vec<BookSummary> {
    // println!("[epub_parser] list_books called, library_path={:?}", library_path);

    // Try to read from the desktop app's library JSON first
    let library_json_path = library_path.parent()
        .unwrap_or(library_path)
        .join("giano-reader-library.json");

    // println!("[epub_parser] Looking for library JSON at: {:?}", library_json_path);
    // println!("[epub_parser] JSON file exists: {}", library_json_path.exists());

    if library_json_path.exists() {
        if let Ok(content) = fs::read_to_string(&library_json_path) {
            // println!("[epub_parser] JSON file read OK, length={} bytes", content.len());
            match serde_json::from_str::<Vec<LibraryEntry>>(&content) {
                Ok(entries) => {
                    // println!("[epub_parser] Parsed {} library entries from JSON", entries.len());
                    let mut books = Vec::new();
                    for entry in &entries {
                        let path = PathBuf::from(&entry.file_path);

                        // Skip non-epub files by extension (fast check before opening)
                        match path.extension().and_then(|ext| ext.to_str()) {
                            Some(ext) if ext.eq_ignore_ascii_case("epub") => {}
                            _ => continue,
                        }

                        if !path.exists() {
                            continue;
                        }
                        if let Some(book) = book_summary_from_path(&path, store, entry.status.clone()) {
                            books.push(book);
                        }
                    }
                    // println!("[epub_parser] Found {} valid books from JSON", books.len());
                    if !books.is_empty() {
                        return books;
                    }
                }
                Err(_e) => {
                    // println!("[epub_parser] Failed to parse JSON: {}", _e);
                }
            }
        } else {
            // println!("[epub_parser] Failed to read JSON file");
        }
    }

    // Fallback: scan library_path directory for .epub files
    // println!("[epub_parser] Falling back to directory scan of {:?}", library_path);
    list_books_from_directory(library_path, store)
}

/// Entry from the desktop app's `giano-reader-library.json` file.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryEntry {
    file_path: String,
    #[allow(dead_code)]
    #[serde(default)]
    title: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

/// Creates a BookSummary from an epub file path.
fn book_summary_from_path(path: &Path, store: &PersistenceStore, status: Option<String>) -> Option<BookSummary> {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let id = generate_book_id(&canonical);

    let doc = match EpubDoc::new(path) {
        Ok(doc) => doc,
        Err(_e) => {
            // eprintln!("[epub_parser] Skipping {:?}: failed to open epub: {}", path, _e);
            return None;
        }
    };

    let title = doc.get_title().unwrap_or_else(|| {
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .to_string()
    });

    let author = doc
        .mdata("creator")
        .map(|item| item.value.clone())
        .unwrap_or_else(|| "Unknown".to_string());

    let cover_url = Some(format!("/api/books/{}/cover", id));

    let progress = store
        .get_reading_state(&id)
        .map(|state| state.progress)
        .unwrap_or(0);

    Some(BookSummary {
        id,
        title,
        author,
        cover_url,
        progress,
        status,
    })
}

/// Scans a directory for .epub files and returns summaries.
fn list_books_from_directory(library_path: &Path, store: &PersistenceStore) -> Vec<BookSummary> {
    let entries = match fs::read_dir(library_path) {
        Ok(entries) => entries,
        Err(_e) => {
            // eprintln!("[epub_parser] Cannot read library directory {:?}: {}", library_path, _e);
            return Vec::new();
        }
    };

    let mut books = Vec::new();

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_e) => {
                // eprintln!("[epub_parser] Error reading directory entry: {}", _e);
                continue;
            }
        };

        let path = entry.path();

        // Only process .epub files
        match path.extension().and_then(|ext| ext.to_str()) {
            Some(ext) if ext.eq_ignore_ascii_case("epub") => {}
            _ => continue,
        }

        if let Some(book) = book_summary_from_path(&path, store, None) {
            books.push(book);
        }
    }

    books
}

/// Generates a stable book id by hashing the canonical path with SHA-256
/// and taking the first 16 hex characters.
pub fn generate_book_id(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    let result = hasher.finalize();
    // Take first 8 bytes (16 hex chars)
    result.iter().take(8).map(|b| format!("{:02x}", b)).collect()
}

/// Finds the epub file in `library_path` whose canonical path hashes to `book_id`.
/// Finds the epub file matching `book_id` by checking the library JSON first,
/// then falling back to scanning `library_path` directory.
/// Returns the path to the epub file, or None if not found.
pub fn find_epub_by_id(library_path: &Path, book_id: &str) -> Option<PathBuf> {
    // First: check the desktop app's library JSON
    let library_json_path = library_path.parent()
        .unwrap_or(library_path)
        .join("giano-reader-library.json");

    if library_json_path.exists() {
        if let Ok(content) = fs::read_to_string(&library_json_path) {
            if let Ok(entries) = serde_json::from_str::<Vec<LibraryEntry>>(&content) {
                for entry in entries {
                    let path = PathBuf::from(&entry.file_path);
                    if !path.exists() {
                        continue;
                    }
                    let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
                    if generate_book_id(&canonical) == book_id {
                        return Some(path);
                    }
                }
            }
        }
    }

    // Fallback: scan directory
    let entries = match fs::read_dir(library_path) {
        Ok(e) => e,
        Err(_) => return None,
    };

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();

        match path.extension().and_then(|ext| ext.to_str()) {
            Some(ext) if ext.eq_ignore_ascii_case("epub") => {}
            _ => continue,
        }

        let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
        if generate_book_id(&canonical) == book_id {
            return Some(path);
        }
    }

    None
}

/// Returns the table of contents for the epub identified by `book_id`.
/// Returns `Err` if the book is not found in `library_path`.
/// Returns `Ok(vec![])` if the epub has no TOC entries.
pub fn get_toc(library_path: &Path, book_id: &str) -> Result<Vec<TocEntry>, String> {
    let epub_path = find_epub_by_id(library_path, book_id)
        .ok_or_else(|| format!("Book not found: {}", book_id))?;

    let doc = EpubDoc::new(&epub_path)
        .map_err(|e| format!("Failed to open epub: {}", e))?;

    let mut entries: Vec<TocEntry> = Vec::new();
    let mut counter: u32 = 0;
    flatten_toc(&doc.toc, 0, &mut entries, &mut counter, &doc);

    Ok(entries)
}

/// Recursively flattens the hierarchical NavPoint tree into a flat list
/// with a `level` field indicating nesting depth and `spine_index` for navigation.
fn flatten_toc<R: std::io::Read + std::io::Seek>(
    nav_points: &[epub::doc::NavPoint],
    level: u32,
    entries: &mut Vec<TocEntry>,
    counter: &mut u32,
    doc: &EpubDoc<R>,
) {
    for nav_point in nav_points {
        // Strip fragment identifier for spine lookup
        let content_path = nav_point.content.to_string_lossy();
        let path_without_fragment = content_path.split('#').next().unwrap_or("");

        // Find the spine index by matching the NavPoint content path to spine items
        let spine_index = find_spine_index_for_path(doc, path_without_fragment);

        entries.push(TocEntry {
            index: *counter,
            title: nav_point.label.clone(),
            href: nav_point.content.to_string_lossy().to_string(),
            level,
            spine_index,
        });
        *counter += 1;
        if !nav_point.children.is_empty() {
            flatten_toc(&nav_point.children, level + 1, entries, counter, doc);
        }
    }
}

/// Finds the spine index for a given content path by matching against the
/// resource paths referenced in the spine.
fn find_spine_index_for_path<R: std::io::Read + std::io::Seek>(
    doc: &EpubDoc<R>,
    path: &str,
) -> Option<u32> {
    for (i, spine_item) in doc.spine.iter().enumerate() {
        // Look up the resource by the spine item's idref
        if let Some(resource) = doc.resources.get(&spine_item.idref) {
            let resource_path = resource.path.to_string_lossy();
            // Compare paths — may need to strip prefixes
            if resource_path == path
                || resource_path.ends_with(path)
                || path.ends_with(&*resource_path)
            {
                return Some(i as u32);
            }
        }
    }
    None
}

/// Returns the cover image bytes and MIME type for the book matching `book_id`.
/// The MIME type is `"image/png"` if the epub reports it as such, otherwise
/// defaults to `"image/jpeg"`.
/// Returns `None` if the book is not found or has no cover.
pub fn get_cover(library_path: &Path, book_id: &str) -> Option<(Vec<u8>, &'static str)> {
    let epub_path = find_epub_by_id(library_path, book_id)?;

    let mut doc = EpubDoc::new(&epub_path).ok()?;

    let (bytes, mime) = doc.get_cover()?;

    let mime_str: &'static str = if mime == "image/png" {
        "image/png"
    } else {
        "image/jpeg"
    };

    Some((bytes, mime_str))
}

/// Returns the chapter content for the book matching `book_id` at `chapter_index`.
/// Parses the XHTML content into paragraphs, stripping disallowed tags.
///
/// Allowed tags in the `html` field: `<em>`, `<strong>`, `<a>`, `<span>` (and their closing tags).
/// The `text` field contains plain text with all HTML tags removed.
///
/// Returns `Err` if:
/// - The book is not found in `library_path`
/// - `chapter_index` is out of range
pub fn get_chapter(library_path: &Path, book_id: &str, chapter_index: u32) -> Result<ChapterResponse, String> {
    let epub_path = find_epub_by_id(library_path, book_id)
        .ok_or_else(|| format!("Book not found: {}", book_id))?;

    let mut doc = EpubDoc::new(&epub_path)
        .map_err(|e| format!("Failed to open epub: {}", e))?;

    let num_chapters = doc.get_num_chapters();
    if chapter_index as usize >= num_chapters {
        return Err(format!(
            "Chapter {} out of range (0–{})",
            chapter_index,
            num_chapters.saturating_sub(1)
        ));
    }

    // Navigate to the requested chapter
    if !doc.set_current_chapter(chapter_index as usize) {
        return Err(format!("Failed to navigate to chapter {}", chapter_index));
    }

    // Get chapter title from TOC if available
    let title = find_chapter_title(&doc, chapter_index);

    // Get the chapter XHTML content
    let (content, _mime) = doc.get_current_str()
        .ok_or_else(|| format!("Failed to read chapter {} content", chapter_index))?;

    // Parse content into paragraphs
    let paragraphs = extract_paragraphs(&content, book_id, chapter_index);

    Ok(ChapterResponse {
        chapter_index,
        title,
        paragraphs,
    })
}

/// Attempts to find the chapter title from the TOC.
/// Falls back to "Chapter {chapter_index + 1}" if not found.
fn find_chapter_title<R: std::io::Read + std::io::Seek>(doc: &EpubDoc<R>, chapter_index: u32) -> String {
    // Try to match TOC entries to the current spine position
    let current_path = doc.get_current_path();

    if let Some(ref path) = current_path {
        for nav_point in &doc.toc {
            // Compare the content path (strip any fragment identifier)
            let nav_content = nav_point.content.to_string_lossy();
            let nav_path_str = nav_content.split('#').next().unwrap_or("");
            let current_str = path.to_string_lossy();

            if current_str.ends_with(nav_path_str) || nav_path_str.ends_with(&*current_str) {
                if !nav_point.label.is_empty() {
                    return nav_point.label.clone();
                }
            }
        }
    }

    format!("Chapter {}", chapter_index + 1)
}

/// Block-level tag names that are treated as individual paragraphs.
/// `blockquote` is included to support dialogue/SMS-style text that epub
/// producers (e.g. calibre) wrap in `<blockquote><span>...</span></blockquote>`
/// instead of `<p>`.
const BLOCK_TAGS: [&str; 9] = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote"];

/// Finds the earliest occurrence of any of `BLOCK_TAGS` starting from `from`.
/// Returns the byte position of the `<` and the matched tag name.
fn find_next_block_tag(content: &str, from: usize) -> Option<(usize, &'static str)> {
    let mut best: Option<(usize, &'static str)> = None;
    for &tag in BLOCK_TAGS.iter() {
        if let Some(pos) = find_tag_start(content, from, tag) {
            if best.is_none_or(|(best_pos, _)| pos < best_pos) {
                best = Some((pos, tag));
            }
        }
    }
    best
}

/// Given the position of a closing tag's `<` (as returned by `find_closing_tag`),
/// returns the byte position right after its `>`. This is more robust than a
/// fixed-length skip since closing tags can vary in length (`</p>` vs `</blockquote>`).
fn skip_past_closing_tag(content: &str, close_pos: usize) -> usize {
    match content[close_pos..].find('>') {
        Some(offset) => close_pos + offset + 1,
        None => close_pos + 1,
    }
}

/// Extracts paragraphs from XHTML content.
/// Scans for block-level tags (`<p>`, `<h1>`-`<h6>`, `<li>`, `<blockquote>`) and
/// processes each one to produce sanitized HTML and plain text.
/// A `<blockquote>` that itself contains nested block-level tags (e.g. a `<p>`,
/// or another `<blockquote>`) is not extracted as its own paragraph — its
/// content is instead picked up individually on later loop iterations — to
/// avoid duplicating text. A "leaf" `<blockquote>` (containing only inline
/// content like `<span>`, as used for dialogue/SMS text) is extracted normally.
/// Generates stable paragraph IDs using sha256(book_id + chapter_index + paragraph_index).
fn extract_paragraphs(content: &str, book_id: &str, chapter_index: u32) -> Vec<Paragraph> {
    let mut paragraphs = Vec::new();

    let mut search_from = 0;
    while let Some((tag_start, tag_name)) = find_next_block_tag(content, search_from) {
        // Find the opening tag end
        let tag_end = match content[tag_start..].find('>') {
            Some(pos) => tag_start + pos + 1,
            None => break,
        };

        // Find the matching closing tag
        let close_tag = match find_closing_tag(content, tag_end, tag_name) {
            Some(pos) => pos,
            None => {
                search_from = tag_end;
                continue;
            }
        };

        let inner_html = &content[tag_end..close_tag];

        // A blockquote wrapping other block-level tags is a container, not a
        // paragraph itself: skip past its opening tag only, so the nested
        // block(s) get extracted individually on the next iterations.
        if tag_name == "blockquote" && find_next_block_tag(inner_html, 0).is_some() {
            search_from = tag_end;
            continue;
        }

        // Skip empty paragraphs
        let text = strip_all_tags(inner_html);
        let trimmed_text = text.trim();
        if trimmed_text.is_empty() {
            search_from = skip_past_closing_tag(content, close_tag);
            continue;
        }

        let html = strip_disallowed_tags(inner_html);
        let index = paragraphs.len() as u32;
        let id = generate_paragraph_id(book_id, chapter_index, index);

        paragraphs.push(Paragraph {
            id,
            index,
            html: html.trim().to_string(),
            text: trimmed_text.to_string(),
        });

        search_from = skip_past_closing_tag(content, close_tag);
    }

    paragraphs
}

/// Generates a stable paragraph id by hashing `book_id + chapter_index + paragraph_index`
/// with SHA-256 and taking the first 16 hex characters (8 bytes).
pub fn generate_paragraph_id(book_id: &str, chapter_index: u32, paragraph_index: u32) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{}{}{}", book_id, chapter_index, paragraph_index).as_bytes());
    let result = hasher.finalize();
    result.iter().take(8).map(|b| format!("{:02x}", b)).collect()
}

/// Finds the start of a tag (e.g., `<p` or `<p `) in content starting from `from`.
/// Returns the byte position of the `<` character.
fn find_tag_start(content: &str, from: usize, tag: &str) -> Option<usize> {
    let slice = &content[from..];
    let mut pos = 0;

    while pos < slice.len() {
        if let Some(lt_pos) = slice[pos..].find('<') {
            let abs_pos = pos + lt_pos;
            let after_lt = &slice[abs_pos + 1..];

            // Check if this is our target tag (not a closing tag)
            if !after_lt.starts_with('/') {
                let tag_bytes = tag.as_bytes();
                let after_bytes = after_lt.as_bytes();

                if after_bytes.len() >= tag_bytes.len() {
                    let matches = after_bytes[..tag_bytes.len()]
                        .iter()
                        .zip(tag_bytes.iter())
                        .all(|(a, b)| a.to_ascii_lowercase() == b.to_ascii_lowercase());

                    if matches {
                        // Ensure the tag name is complete (followed by space, >, or /)
                        let next_char_pos = tag_bytes.len();
                        if next_char_pos < after_bytes.len() {
                            let next_char = after_bytes[next_char_pos];
                            if next_char == b' ' || next_char == b'>' || next_char == b'/'
                                || next_char == b'\n' || next_char == b'\r' || next_char == b'\t'
                            {
                                return Some(from + abs_pos);
                            }
                        } else if next_char_pos == after_bytes.len() {
                            // Tag at end of string
                            return Some(from + abs_pos);
                        }
                    }
                }
            }

            pos = abs_pos + 1;
        } else {
            break;
        }
    }

    None
}

/// Finds the closing tag (e.g., `</p>`) after `from` position.
/// Handles nested tags of the same type by counting depth.
fn find_closing_tag(content: &str, from: usize, tag: &str) -> Option<usize> {
    let close_pattern = format!("</{}", tag);
    let slice = &content[from..];
    let mut depth = 0;
    let mut pos = 0;

    while pos < slice.len() {
        if let Some(lt_pos) = slice[pos..].find('<') {
            let abs_pos = pos + lt_pos;
            let remaining = &slice[abs_pos..];

            // Check for closing tag
            if remaining.len() >= close_pattern.len()
                && remaining[..close_pattern.len()].eq_ignore_ascii_case(&close_pattern)
            {
                // Check it's actually closed (next char should be > or space)
                let after = &remaining[close_pattern.len()..];
                if after.starts_with('>') || after.starts_with(' ') {
                    if depth == 0 {
                        return Some(from + abs_pos);
                    }
                    depth -= 1;
                }
            }
            // Check for opening tag of same type (nested)
            else if !remaining.starts_with("</") {
                let after_lt = &remaining[1..];
                let tag_bytes = tag.as_bytes();
                let after_bytes = after_lt.as_bytes();

                if after_bytes.len() >= tag_bytes.len() {
                    let matches = after_bytes[..tag_bytes.len()]
                        .iter()
                        .zip(tag_bytes.iter())
                        .all(|(a, b)| a.to_ascii_lowercase() == b.to_ascii_lowercase());

                    if matches {
                        let next_pos = tag_bytes.len();
                        if next_pos < after_bytes.len() {
                            let nc = after_bytes[next_pos];
                            if nc == b' ' || nc == b'>' || nc == b'/' || nc == b'\n' || nc == b'\r' || nc == b'\t' {
                                depth += 1;
                            }
                        }
                    }
                }
            }

            pos = abs_pos + 1;
        } else {
            break;
        }
    }

    None
}

/// Strips all HTML tags that are NOT in the allowed set: em, strong, a, span.
/// Preserves the text content of removed tags.
fn strip_disallowed_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut pos = 0;
    let bytes = html.as_bytes();

    while pos < bytes.len() {
        if bytes[pos] == b'<' {
            // Find the end of the tag
            if let Some(tag_end) = html[pos..].find('>') {
                let tag_content = &html[pos..pos + tag_end + 1];

                if is_allowed_tag(tag_content) {
                    result.push_str(tag_content);
                }
                // Otherwise, skip the tag but keep going (text content is preserved)

                pos += tag_end + 1;
            } else {
                // Malformed tag at end of string, skip the '<'
                pos += 1;
            }
        } else {
            result.push(html[pos..].chars().next().unwrap());
            pos += html[pos..].chars().next().unwrap().len_utf8();
        }
    }

    result
}

/// Checks if a tag string is in the allowed set.
/// Allowed: <em>, </em>, <strong>, </strong>, <a ...>, </a>, <span ...>, </span>
fn is_allowed_tag(tag: &str) -> bool {
    let inner = tag.trim_start_matches('<').trim_end_matches('>').trim();

    // Check closing tags
    if let Some(name) = inner.strip_prefix('/') {
        let name = name.trim().to_ascii_lowercase();
        return matches!(name.as_str(), "em" | "strong" | "a" | "span");
    }

    // Check opening tags — extract just the tag name (before any attributes)
    let name = inner.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
    // Handle self-closing like <br/>
    let name = name.trim_end_matches('/');

    matches!(name, "em" | "strong" | "a" | "span")
}

/// Strips ALL HTML tags from the content, returning plain text.
fn strip_all_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;

    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn generate_book_id_is_deterministic() {
        let path = PathBuf::from("/some/path/to/book.epub");
        let id1 = generate_book_id(&path);
        let id2 = generate_book_id(&path);
        assert_eq!(id1, id2);
        assert_eq!(id1.len(), 16);
    }

    #[test]
    fn generate_book_id_is_hex() {
        let path = PathBuf::from("/another/book.epub");
        let id = generate_book_id(&path);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn list_books_returns_empty_for_nonexistent_dir() {
        let temp_dir = PathBuf::from("nonexistent_dir_that_does_not_exist_12345");
        let store = create_test_store();
        let result = list_books(&temp_dir, &store);
        assert!(result.is_empty());
    }

    fn create_test_store() -> PersistenceStore {
        let temp = std::env::temp_dir().join(format!("giano_test_{}", std::process::id()));
        PersistenceStore::open(temp).expect("Failed to open test store")
    }

    #[test]
    fn strip_all_tags_removes_everything() {
        assert_eq!(strip_all_tags("<p>Hello <em>world</em></p>"), "Hello world");
        assert_eq!(strip_all_tags("plain text"), "plain text");
        assert_eq!(strip_all_tags("<a href=\"x\">link</a>"), "link");
    }

    #[test]
    fn strip_disallowed_tags_keeps_allowed() {
        let input = "<em>italic</em> and <strong>bold</strong>";
        assert_eq!(strip_disallowed_tags(input), "<em>italic</em> and <strong>bold</strong>");
    }

    #[test]
    fn strip_disallowed_tags_removes_div() {
        let input = "<div>inside div</div>";
        assert_eq!(strip_disallowed_tags(input), "inside div");
    }

    #[test]
    fn strip_disallowed_tags_preserves_a_with_attrs() {
        let input = r#"<a href="http://example.com">link</a>"#;
        assert_eq!(strip_disallowed_tags(input), r#"<a href="http://example.com">link</a>"#);
    }

    #[test]
    fn strip_disallowed_tags_preserves_span_with_attrs() {
        let input = r#"<span class="note">text</span>"#;
        assert_eq!(strip_disallowed_tags(input), r#"<span class="note">text</span>"#);
    }

    #[test]
    fn strip_disallowed_tags_removes_br_and_img() {
        let input = "text<br/>more<img src=\"x\"/>end";
        assert_eq!(strip_disallowed_tags(input), "textmoreend");
    }

    #[test]
    fn is_allowed_tag_works() {
        assert!(is_allowed_tag("<em>"));
        assert!(is_allowed_tag("</em>"));
        assert!(is_allowed_tag("<strong>"));
        assert!(is_allowed_tag("</strong>"));
        assert!(is_allowed_tag("<a href=\"x\">"));
        assert!(is_allowed_tag("</a>"));
        assert!(is_allowed_tag("<span class=\"y\">"));
        assert!(is_allowed_tag("</span>"));
        assert!(!is_allowed_tag("<div>"));
        assert!(!is_allowed_tag("<br/>"));
        assert!(!is_allowed_tag("<img src=\"x\">"));
        assert!(!is_allowed_tag("<h1>"));
    }

    #[test]
    fn extract_paragraphs_basic() {
        let content = "<html><body><p>First paragraph</p><p>Second paragraph</p></body></html>";
        let paras = extract_paragraphs(content, "test_book", 0);
        assert_eq!(paras.len(), 2);
        assert_eq!(paras[0].text, "First paragraph");
        assert_eq!(paras[0].index, 0);
        assert_eq!(paras[1].text, "Second paragraph");
        assert_eq!(paras[1].index, 1);
    }

    #[test]
    fn extract_paragraphs_with_formatting() {
        let content = "<p>This is <em>italic</em> and <strong>bold</strong> and <div>nested</div> text</p>";
        let paras = extract_paragraphs(content, "test_book", 0);
        assert_eq!(paras.len(), 1);
        assert_eq!(paras[0].html, "This is <em>italic</em> and <strong>bold</strong> and nested text");
        assert_eq!(paras[0].text, "This is italic and bold and nested text");
    }

    #[test]
    fn extract_paragraphs_skips_empty() {
        let content = "<p></p><p>   </p><p>Real content</p>";
        let paras = extract_paragraphs(content, "test_book", 0);
        assert_eq!(paras.len(), 1);
        assert_eq!(paras[0].text, "Real content");
        assert_eq!(paras[0].index, 0);
    }

    #[test]
    fn extract_paragraphs_with_class() {
        let content = r#"<p class="intro">Hello world</p>"#;
        let paras = extract_paragraphs(content, "test_book", 0);
        assert_eq!(paras.len(), 1);
        assert_eq!(paras[0].text, "Hello world");
    }

    #[test]
    fn extract_paragraphs_includes_headings_and_list_items() {
        let content = "<h1>Title</h1><li>Item one</li>";
        let paras = extract_paragraphs(content, "test_book", 0);
        assert_eq!(paras.len(), 2);
        assert_eq!(paras[0].text, "Title");
        assert_eq!(paras[1].text, "Item one");
    }

    #[test]
    fn extract_paragraphs_includes_leaf_blockquote_with_nested_spans() {
        // Regression test: calibre-produced epubs wrap SMS/dialogue text like
        // `-having fun. wish you were here` in nested <span> tags inside a
        // <blockquote>, with no <p> at all. This text must not be dropped.
        let content = concat!(
            r#"<p class="calibre12">Then we're going to have to do something about that.</p>"#,
            r#"<blockquote class="calibre16"><span class="italic">"#,
            r#"<span class="calibre3">-having fun. wish you were here</span></span></blockquote>"#,
            r#"<p class="calibre18">In the picture, Erin was posing with Liz.</p>"#,
        );
        let paras = extract_paragraphs(content, "test_book", 0);
        let texts: Vec<&str> = paras.iter().map(|p| p.text.as_str()).collect();
        assert!(texts.contains(&"-having fun. wish you were here"));
        assert_eq!(paras.len(), 3);
    }

    #[test]
    fn extract_paragraphs_handles_double_nested_blockquote() {
        // Some epubs nest two <blockquote> levels around the leaf span.
        let content = concat!(
            r#"<blockquote class="calibre19"><blockquote class="calibre17">"#,
            r#"<span class="italic"><span class="calibre3">-i miss you</span></span>"#,
            r#"</blockquote></blockquote>"#,
        );
        let paras = extract_paragraphs(content, "test_book", 0);
        assert_eq!(paras.len(), 1);
        assert_eq!(paras[0].text, "-i miss you");
    }

    #[test]
    fn extract_paragraphs_blockquote_with_nested_p_is_not_duplicated() {
        let content = "<blockquote><p>Quoted text</p></blockquote>";
        let paras = extract_paragraphs(content, "test_book", 0);
        assert_eq!(paras.len(), 1);
        assert_eq!(paras[0].text, "Quoted text");
    }

    #[test]
    fn find_tag_start_does_not_match_pre() {
        // Should not match <pre> when looking for <p>
        let content = "<pre>code</pre><p>text</p>";
        let pos = find_tag_start(content, 0, "p");
        assert!(pos.is_some());
        // The first match should be the <p> tag, not <pre>
        let found = &content[pos.unwrap()..];
        assert!(found.starts_with("<p>"));
    }

    #[test]
    fn get_toc_returns_error_for_nonexistent_book() {
        let temp_dir = std::env::temp_dir();
        let result = get_toc(&temp_dir, "nonexistent_id_000");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Book not found"));
    }

    #[test]
    fn get_toc_returns_error_for_nonexistent_dir() {
        let bad_dir = PathBuf::from("totally_nonexistent_dir_xyz");
        let result = get_toc(&bad_dir, "any_id");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Book not found"));
    }

    #[test]
    fn generate_paragraph_id_is_deterministic() {
        let id1 = generate_paragraph_id("book123", 0, 0);
        let id2 = generate_paragraph_id("book123", 0, 0);
        assert_eq!(id1, id2);
        assert_eq!(id1.len(), 16);
        assert!(id1.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn generate_paragraph_id_varies_with_inputs() {
        let id_a = generate_paragraph_id("book1", 0, 0);
        let id_b = generate_paragraph_id("book1", 0, 1);
        let id_c = generate_paragraph_id("book1", 1, 0);
        let id_d = generate_paragraph_id("book2", 0, 0);
        assert_ne!(id_a, id_b);
        assert_ne!(id_a, id_c);
        assert_ne!(id_a, id_d);
    }

    #[test]
    fn extract_paragraphs_generates_stable_ids() {
        let content = "<p>First</p><p>Second</p>";
        let paras1 = extract_paragraphs(content, "mybook", 3);
        let paras2 = extract_paragraphs(content, "mybook", 3);
        assert_eq!(paras1[0].id, paras2[0].id);
        assert_eq!(paras1[1].id, paras2[1].id);
        // IDs should be 16 hex chars
        assert_eq!(paras1[0].id.len(), 16);
        assert!(paras1[0].id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn get_chapter_returns_error_for_nonexistent_book() {
        let temp_dir = std::env::temp_dir();
        let result = get_chapter(&temp_dir, "nonexistent_id_000", 0);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Book not found"));
    }
}
