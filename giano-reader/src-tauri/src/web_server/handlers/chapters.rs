use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use std::sync::Arc;

use crate::web_server::epub_parser;
use crate::web_server::models::ApiError;

use super::books::AppState;

/// GET /api/books/:id/chapter/:chapterIndex
pub async fn get_chapter(
    State(state): State<Arc<AppState>>,
    Path((id, chapter_index)): Path<(String, u32)>,
) -> impl IntoResponse {
    match epub_parser::get_chapter(&state.library_path, &id, chapter_index) {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(msg) => (StatusCode::NOT_FOUND, Json(ApiError { error: msg })).into_response(),
    }
}
