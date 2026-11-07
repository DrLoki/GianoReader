use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use std::path::PathBuf;
use std::sync::Arc;

use crate::web_server::epub_parser;
use crate::web_server::middleware::AuthGuard;
use crate::web_server::models::ApiError;
use crate::web_server::persistence::PersistenceStore;

/// Shared application state passed to all axum handlers via `State<Arc<AppState>>`.
pub struct AppState {
    pub library_path: PathBuf,
    pub store: PersistenceStore,
    /// Per-IP failed password counters (brute-force protection).
    pub auth_guard: AuthGuard,
}

impl AppState {
    pub fn new(library_path: PathBuf, store: PersistenceStore) -> Self {
        Self {
            library_path,
            store,
            auth_guard: AuthGuard::default(),
        }
    }
}

/// Runs blocking EPUB work (zip decompression, XML parsing) off the async
/// runtime threads so one large book cannot stall every other request.
pub async fn blocking<T, F>(f: F) -> Result<T, StatusCode>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

/// GET /api/books
pub async fn list_books(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let st = state.clone();
    match blocking(move || epub_parser::list_books(&st.library_path, &st.store)).await {
        Ok(books) => (StatusCode::OK, Json(books)).into_response(),
        Err(code) => code.into_response(),
    }
}

/// GET /api/books/:id/cover
pub async fn get_cover(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let library_path = state.library_path.clone();
    let result = blocking(move || epub_parser::get_cover(&library_path, &id)).await;
    match result {
        Ok(Some((bytes, mime))) => {
            let headers = [
                (header::CONTENT_TYPE, mime),
                // Covers rarely change; let the phone keep them for a day
                (header::CACHE_CONTROL, "private, max-age=86400"),
            ];
            (StatusCode::OK, headers, bytes).into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(code) => code.into_response(),
    }
}

/// GET /api/books/:id/toc
pub async fn get_toc(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let library_path = state.library_path.clone();
    match blocking(move || epub_parser::get_toc(&library_path, &id)).await {
        Ok(Ok(entries)) => (StatusCode::OK, Json(entries)).into_response(),
        Ok(Err(msg)) => (StatusCode::NOT_FOUND, Json(ApiError { error: msg })).into_response(),
        Err(code) => code.into_response(),
    }
}
