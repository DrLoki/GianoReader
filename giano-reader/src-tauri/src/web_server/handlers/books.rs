use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use std::path::PathBuf;
use std::sync::Arc;

use crate::web_server::epub_parser;
use crate::web_server::library_rating::{self, RatingError};
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

/// PUT /api/books/:id/rating
///
/// Body: `{ "rating": 1..=5 }` to set, `{ "rating": null }` to clear.
/// Stores the rating in the desktop library JSON so the desktop app sees it.
pub async fn put_rating(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let rating = match body.get("rating") {
        Some(serde_json::Value::Null) => None,
        Some(v) => match library_rating::normalize_rating(v) {
            Some(n) => Some(n),
            None => return bad_rating(),
        },
        None => return bad_rating(),
    };

    let library_path = state.library_path.clone();
    match blocking(move || library_rating::set_book_rating(&library_path, &id, rating)).await {
        Ok(Ok(stored)) => (StatusCode::OK, Json(serde_json::json!({ "rating": stored }))).into_response(),
        Ok(Err(RatingError::NotFound)) => (
            StatusCode::NOT_FOUND,
            Json(ApiError { error: "Book not found in the desktop library".into() }),
        )
            .into_response(),
        Ok(Err(RatingError::Unavailable(msg))) => {
            eprintln!("[web_server] rating not saved: {msg}");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ApiError { error: "Library file is busy, try again".into() }),
            )
                .into_response()
        }
        Err(code) => code.into_response(),
    }
}

fn bad_rating() -> axum::response::Response {
    (
        StatusCode::BAD_REQUEST,
        Json(ApiError { error: "rating: must be an integer from 1 to 5, or null".into() }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request, routing::put, Router};
    use serde_json::{json, Value};
    use tower::ServiceExt;

    /// Library dir + desktop library JSON with one book. Returns (app, book id, json path).
    fn setup() -> (Router, String, PathBuf) {
        let root = std::env::temp_dir().join(format!("giano-test-rating-{}", uuid::Uuid::new_v4()));
        let library = root.join("library");
        std::fs::create_dir_all(&library).unwrap();
        let book = root.join("book.epub");
        std::fs::write(&book, b"x").unwrap();
        let json_path = root.join("giano-reader-library.json");
        std::fs::write(
            &json_path,
            json!([{ "id": "7", "filePath": book.to_string_lossy(), "status": "reading" }]).to_string(),
        )
        .unwrap();
        let id = epub_parser::generate_book_id(&book.canonicalize().unwrap());
        let store = PersistenceStore::open(root.join("db")).unwrap();
        let state = Arc::new(AppState::new(library, store));
        let app = Router::new()
            .route("/api/books/{id}/rating", put(put_rating))
            .with_state(state);
        (app, id, json_path)
    }

    async fn send(app: Router, id: &str, body: Value) -> StatusCode {
        let req = Request::builder()
            .method("PUT")
            .uri(format!("/api/books/{id}/rating"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        app.oneshot(req).await.unwrap().status()
    }

    #[tokio::test]
    async fn put_rating_stores_value_in_desktop_library() {
        let (app, id, json_path) = setup();
        assert_eq!(send(app.clone(), &id, json!({ "rating": 5 })).await, StatusCode::OK);
        let entries: Value = serde_json::from_str(&std::fs::read_to_string(&json_path).unwrap()).unwrap();
        assert_eq!(entries[0]["rating"], json!(5));
        assert_eq!(entries[0]["status"], json!("reading"));

        assert_eq!(send(app, &id, json!({ "rating": null })).await, StatusCode::OK);
        let entries: Value = serde_json::from_str(&std::fs::read_to_string(&json_path).unwrap()).unwrap();
        assert_eq!(entries[0]["rating"], Value::Null);
    }

    #[tokio::test]
    async fn put_rating_rejects_invalid_values() {
        let (app, id, _) = setup();
        for body in [json!({ "rating": 0 }), json!({ "rating": 6 }), json!({ "rating": "3" }), json!({})] {
            assert_eq!(send(app.clone(), &id, body.clone()).await, StatusCode::BAD_REQUEST, "{body}");
        }
    }

    #[tokio::test]
    async fn put_rating_unknown_book_is_404() {
        let (app, _, _) = setup();
        assert_eq!(send(app, "ffffffffffffffff", json!({ "rating": 3 })).await, StatusCode::NOT_FOUND);
    }
}
