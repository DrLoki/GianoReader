use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use std::sync::Arc;

use crate::web_server::epub_parser;
use crate::web_server::models::ApiError;
use crate::web_server::persistence::BookmarkBook;
use super::books::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBookmarkRequest {
    pub chapter_index: Option<serde_json::Value>,
    pub paragraph_id: Option<serde_json::Value>,
    pub label: Option<String>,
}

/// Scroll percentage (0–100) of the paragraph at `position` in a chapter of
/// `count` paragraphs: 0 for the first one, 100 for the last.
pub fn paragraph_scroll_pct(position: usize, count: usize) -> u32 {
    if count < 2 {
        return 0;
    }
    let last = count - 1;
    ((position.min(last) * 100 + last / 2) / last) as u32
}

/// GET /api/books/:id/bookmarks
/// Returns 200 with a JSON array of bookmarks sorted by chapterIndex asc, paragraphId numerically asc.
pub async fn list_bookmarks(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.store.list_bookmarks(&id) {
        Ok(bookmarks) => (StatusCode::OK, Json(bookmarks)).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: "Failed to retrieve bookmarks".to_string(),
            }),
        )
            .into_response(),
    }
}

/// POST /api/books/:id/bookmarks
/// Validates input, creates a bookmark, and returns 201 with the created Bookmark.
/// Returns 400 on validation failure.
pub async fn create_bookmark(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<CreateBookmarkRequest>,
) -> impl IntoResponse {
    // Validate chapterIndex: required, must be a non-negative integer
    let chapter_index = match &body.chapter_index {
        Some(serde_json::Value::Number(n)) => {
            if let Some(val) = n.as_u64() {
                if val > u32::MAX as u64 {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(ApiError {
                            error: "chapterIndex must be a non-negative integer".to_string(),
                        }),
                    )
                        .into_response();
                }
                val as u32
            } else {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ApiError {
                        error: "chapterIndex must be a non-negative integer".to_string(),
                    }),
                )
                    .into_response();
            }
        }
        Some(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: "chapterIndex must be a non-negative integer".to_string(),
                }),
            )
                .into_response();
        }
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: "chapterIndex is required".to_string(),
                }),
            )
                .into_response();
        }
    };

    // Validate paragraphId: required, must be a string
    let paragraph_id = match &body.paragraph_id {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: "paragraphId must be a string".to_string(),
                }),
            )
                .into_response();
        }
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: "paragraphId is required".to_string(),
                }),
            )
                .into_response();
        }
    };

    // Validate label: optional but max 200 chars
    if let Some(ref label) = body.label {
        if label.len() > 200 {
            return (
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: "label must not exceed 200 characters".to_string(),
                }),
            )
                .into_response();
        }
    }

    // Create the bookmark. File lookup and file write are blocking work.
    let label = body.label.clone();
    let created = super::books::blocking(move || {
        let book = epub_parser::book_file_info(&state.library_path, &id).map(|(path, title)| {
            BookmarkBook {
                file_name: path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                file_path: path.to_string_lossy().into_owned(),
                title,
            }
        });
        // Position of the paragraph inside its chapter, as the percentage the
        // desktop app scrolls to when it opens the bookmark.
        let scroll_pct = epub_parser::get_chapter(&state.library_path, &id, chapter_index)
            .ok()
            .and_then(|chapter| {
                let count = chapter.paragraphs.len();
                chapter
                    .paragraphs
                    .iter()
                    .position(|p| p.id == paragraph_id)
                    .map(|pos| paragraph_scroll_pct(pos, count))
            })
            .unwrap_or(0);
        state
            .store
            .create_bookmark(&id, chapter_index, &paragraph_id, label, book, scroll_pct)
    })
    .await;

    match created {
        Ok(Ok(bookmark)) => (StatusCode::CREATED, Json(bookmark)).into_response(),
        Ok(Err(_)) | Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: "Failed to create bookmark".to_string(),
            }),
        )
            .into_response(),
    }
}

/// DELETE /api/books/:id/bookmarks/:bookmarkId
/// Returns 204 if the bookmark existed and was deleted.
/// Returns 404 if the bookmark was not found.
pub async fn delete_bookmark(
    State(state): State<Arc<AppState>>,
    Path((id, bookmark_id)): Path<(String, String)>,
) -> impl IntoResponse {
    match state.store.delete_bookmark(&id, &bookmark_id) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: "Bookmark not found".to_string(),
            }),
        )
            .into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: "Failed to delete bookmark".to_string(),
            }),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::paragraph_scroll_pct;

    #[test]
    fn paragraph_scroll_pct_spans_the_chapter() {
        assert_eq!(paragraph_scroll_pct(0, 11), 0);
        assert_eq!(paragraph_scroll_pct(5, 11), 50);
        assert_eq!(paragraph_scroll_pct(10, 11), 100);
        assert_eq!(paragraph_scroll_pct(1, 4), 33);
        // Degenerate chapters and out-of-range positions
        assert_eq!(paragraph_scroll_pct(0, 0), 0);
        assert_eq!(paragraph_scroll_pct(0, 1), 0);
        assert_eq!(paragraph_scroll_pct(99, 11), 100);
    }
}
