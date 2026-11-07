use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use std::sync::Arc;

use crate::web_server::epub_parser;
use crate::web_server::models::ApiError;

use super::books::{blocking, AppState};

/// GET /api/books/:id/chapter/:chapterIndex
pub async fn get_chapter(
    State(state): State<Arc<AppState>>,
    Path((id, chapter_index)): Path<(String, u32)>,
) -> impl IntoResponse {
    let library_path = state.library_path.clone();
    match blocking(move || epub_parser::get_chapter(&library_path, &id, chapter_index)).await {
        Ok(Ok(response)) => (StatusCode::OK, Json(response)).into_response(),
        Ok(Err(msg)) => (StatusCode::NOT_FOUND, Json(ApiError { error: msg })).into_response(),
        Err(code) => code.into_response(),
    }
}
