use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use std::sync::Arc;

use crate::web_server::models::ApiError;
use super::books::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBookmarkRequest {
    pub chapter_index: Option<serde_json::Value>,
    pub paragraph_id: Option<serde_json::Value>,
    pub label: Option<String>,
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

    // Create the bookmark
    match state.store.create_bookmark(&id, chapter_index, &paragraph_id, body.label.clone()) {
        Ok(bookmark) => (StatusCode::CREATED, Json(bookmark)).into_response(),
        Err(_) => (
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
