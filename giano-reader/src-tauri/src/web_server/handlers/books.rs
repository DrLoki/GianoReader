use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use std::path::PathBuf;
use std::sync::Arc;

use crate::web_server::epub_parser;
use crate::web_server::models::ApiError;
use crate::web_server::persistence::PersistenceStore;

/// Shared application state passed to all axum handlers via `State<Arc<AppState>>`.
pub struct AppState {
    pub library_path: PathBuf,
    pub store: PersistenceStore,
}

/// GET /api/books
pub async fn list_books(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let books = epub_parser::list_books(&state.library_path, &state.store);
    (StatusCode::OK, Json(books))
}

/// GET /api/books/:id/cover
pub async fn get_cover(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match epub_parser::get_cover(&state.library_path, &id) {
        Some((bytes, mime)) => {
            let headers = [(header::CONTENT_TYPE, mime)];
            (StatusCode::OK, headers, bytes).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// GET /api/books/:id/toc
pub async fn get_toc(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match epub_parser::get_toc(&state.library_path, &id) {
        Ok(entries) => (StatusCode::OK, Json(entries)).into_response(),
        Err(msg) => (StatusCode::NOT_FOUND, Json(ApiError { error: msg })).into_response(),
    }
}
