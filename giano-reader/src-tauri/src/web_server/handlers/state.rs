use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use std::sync::Arc;

use super::books::AppState;
use crate::web_server::models::{ApiError, ReadingState};

/// Request body for PUT /api/books/:id/state.
/// All fields are `Option<serde_json::Value>` so we can perform manual validation
/// and return meaningful error messages for each invalid field.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PutReadingStateRequest {
    pub current_chapter: Option<serde_json::Value>,
    pub paragraph_id: Option<serde_json::Value>,
    pub scroll_offset: Option<serde_json::Value>,
    pub progress: Option<serde_json::Value>,
}

/// GET /api/books/:id/state — returns the persisted reading state for the book.
/// Returns the default `{ currentChapter: 0, paragraphId: null, scrollOffset: 0, progress: 0 }`
/// when no state has been saved.
pub async fn get_reading_state(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.store.get_reading_state(&id) {
        Ok(reading_state) => (StatusCode::OK, Json(reading_state)).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: "Failed to read reading state".to_string(),
            }),
        )
            .into_response(),
    }
}

/// PUT /api/books/:id/state — persists the reading state for the book.
/// Validates:
///   - `currentChapter`: required, must be a non-negative integer
///   - `scrollOffset`: required, must be a non-negative number
///   - `progress`: required, must be an integer in range 0–100
/// Returns 400 with `{ error: "<fieldName>: <description>" }` on validation failure.
/// Returns 200 on success.
pub async fn put_reading_state(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<PutReadingStateRequest>,
) -> impl IntoResponse {
    // Validate currentChapter: required, non-negative integer
    let current_chapter = match &body.current_chapter {
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: "currentChapter: required".to_string(),
                }),
            )
                .into_response();
        }
        Some(val) => {
            if let Some(n) = val.as_u64() {
                if n > u32::MAX as u64 {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(ApiError {
                            error: "currentChapter: must be a non-negative integer".to_string(),
                        }),
                    )
                        .into_response();
                }
                n as u32
            } else if let Some(n) = val.as_i64() {
                if n < 0 {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(ApiError {
                            error: "currentChapter: must be a non-negative integer".to_string(),
                        }),
                    )
                        .into_response();
                }
                n as u32
            } else if let Some(f) = val.as_f64() {
                if f < 0.0 || f.fract() != 0.0 {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(ApiError {
                            error: "currentChapter: must be a non-negative integer".to_string(),
                        }),
                    )
                        .into_response();
                }
                f as u32
            } else {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ApiError {
                        error: "currentChapter: must be a non-negative integer".to_string(),
                    }),
                )
                    .into_response();
            }
        }
    };

    // Validate scrollOffset: required, non-negative number
    let scroll_offset = match &body.scroll_offset {
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: "scrollOffset: required".to_string(),
                }),
            )
                .into_response();
        }
        Some(val) => {
            if let Some(f) = val.as_f64() {
                if f < 0.0 {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(ApiError {
                            error: "scrollOffset: must be non-negative".to_string(),
                        }),
                    )
                        .into_response();
                }
                f
            } else {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ApiError {
                        error: "scrollOffset: must be non-negative".to_string(),
                    }),
                )
                    .into_response();
            }
        }
    };

    // Validate progress: required, integer 0–100
    let progress = match &body.progress {
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: "progress: required".to_string(),
                }),
            )
                .into_response();
        }
        Some(val) => {
            if let Some(n) = val.as_u64() {
                if n > 100 {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(ApiError {
                            error: "progress: must be between 0 and 100".to_string(),
                        }),
                    )
                        .into_response();
                }
                n as u8
            } else if let Some(n) = val.as_i64() {
                if n < 0 || n > 100 {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(ApiError {
                            error: "progress: must be between 0 and 100".to_string(),
                        }),
                    )
                        .into_response();
                }
                n as u8
            } else if let Some(f) = val.as_f64() {
                if f < 0.0 || f > 100.0 || f.fract() != 0.0 {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(ApiError {
                            error: "progress: must be between 0 and 100".to_string(),
                        }),
                    )
                        .into_response();
                }
                f as u8
            } else {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ApiError {
                        error: "progress: must be between 0 and 100".to_string(),
                    }),
                )
                    .into_response();
            }
        }
    };

    // paragraphId: optional string (null is valid)
    let paragraph_id = match &body.paragraph_id {
        None | Some(serde_json::Value::Null) => None,
        Some(val) => match val.as_str() {
            Some(s) => Some(s.to_string()),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ApiError {
                        error: "paragraphId: must be a string or null".to_string(),
                    }),
                )
                    .into_response();
            }
        },
    };

    let reading_state = ReadingState {
        current_chapter,
        paragraph_id,
        scroll_offset,
        progress,
    };

    match state.store.put_reading_state(&id, &reading_state) {
        Ok(()) => (StatusCode::OK, Json(reading_state)).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: "Failed to persist reading state".to_string(),
            }),
        )
            .into_response(),
    }
}
