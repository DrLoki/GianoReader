use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use std::sync::Arc;

use crate::web_server::models::ApiError;
use super::books::AppState;

/// The 12 supported BCP-47 translation language codes.
const SUPPORTED_TRANSLATION_LANGS: &[&str] = &[
    "it", "en", "fr", "de", "es", "pt", "ru", "zh", "ja", "ar", "fil", "sq",
];

/// Valid theme values.
const VALID_THEMES: &[&str] = &["light", "dark", "sepia"];

/// Valid UI language values.
const VALID_UI_LANGUAGES: &[&str] = &["it", "en"];

/// Request body for PUT /api/preferences.
/// All fields are optional to support partial updates.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PutPreferencesRequest {
    pub theme: Option<String>,
    pub ui_language: Option<String>,
    pub translation_lang: Option<String>,
    pub font_size: Option<serde_json::Value>,
}

/// GET /api/preferences
///
/// Returns the full Preferences object.
/// If nothing has been saved, returns defaults:
/// `{ theme: "dark", uiLanguage: "en", translationLang: "it", fontSize: 16 }`
pub async fn get_preferences(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.store.get_preferences() {
        Ok(prefs) => (StatusCode::OK, Json(prefs)).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: "Failed to retrieve preferences".to_string(),
            }),
        )
            .into_response(),
    }
}

/// PUT /api/preferences
///
/// Partial update semantics: accepts any subset of fields.
/// Empty body is a valid no-op.
///
/// Validates provided fields:
/// - `fontSize`: must be 12–32
/// - `theme`: must be one of `["light", "dark", "sepia"]`
/// - `uiLanguage`: must be one of `["it", "en"]`
/// - `translationLang`: must be one of the 12 supported BCP-47 codes
///
/// On validation success: loads current prefs, merges provided fields,
/// persists, and returns 200 with the full updated Preferences.
pub async fn put_preferences(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PutPreferencesRequest>,
) -> impl IntoResponse {
    // Validate fontSize if present
    if let Some(ref font_size_val) = body.font_size {
        match font_size_val.as_u64() {
            Some(n) if (12..=32).contains(&n) => {}
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ApiError {
                        error: "fontSize: must be an integer between 12 and 32".to_string(),
                    }),
                )
                    .into_response();
            }
        }
    }

    // Validate theme if present
    if let Some(ref theme) = body.theme {
        if !VALID_THEMES.contains(&theme.as_str()) {
            return (
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: format!(
                        "theme: must be one of {:?}",
                        VALID_THEMES
                    ),
                }),
            )
                .into_response();
        }
    }

    // Validate uiLanguage if present
    if let Some(ref ui_language) = body.ui_language {
        if !VALID_UI_LANGUAGES.contains(&ui_language.as_str()) {
            return (
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: format!(
                        "uiLanguage: must be one of {:?}",
                        VALID_UI_LANGUAGES
                    ),
                }),
            )
                .into_response();
        }
    }

    // Validate translationLang if present
    if let Some(ref translation_lang) = body.translation_lang {
        if !SUPPORTED_TRANSLATION_LANGS.contains(&translation_lang.as_str()) {
            return (
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: format!(
                        "translationLang: must be one of {:?}",
                        SUPPORTED_TRANSLATION_LANGS
                    ),
                }),
            )
                .into_response();
        }
    }

    // Load current preferences
    let mut prefs = match state.store.get_preferences() {
        Ok(p) => p,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: "Failed to retrieve preferences".to_string(),
                }),
            )
                .into_response();
        }
    };

    // Merge provided fields
    if let Some(theme) = body.theme {
        prefs.theme = theme;
    }
    if let Some(ui_language) = body.ui_language {
        prefs.ui_language = ui_language;
    }
    if let Some(translation_lang) = body.translation_lang {
        prefs.translation_lang = translation_lang;
    }
    if let Some(ref font_size_val) = body.font_size {
        // Already validated above, safe to unwrap
        prefs.font_size = font_size_val.as_u64().unwrap() as u8;
    }

    // Persist
    match state.store.put_preferences(&prefs) {
        Ok(()) => (StatusCode::OK, Json(prefs)).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: "Failed to save preferences".to_string(),
            }),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        routing::{get},
        Router,
    };
    use tower::ServiceExt;
    use serde_json::json;
    use std::path::PathBuf;
    use crate::web_server::persistence::PersistenceStore;

    fn create_test_app() -> Router {
        let tmp_dir = std::env::temp_dir().join(format!(
            "giano-test-prefs-{}",
            uuid::Uuid::new_v4()
        ));
        let store = PersistenceStore::open(tmp_dir).unwrap();
        let state = Arc::new(AppState {
            library_path: PathBuf::new(),
            store,
        });

        Router::new()
            .route("/api/preferences", get(get_preferences).put(put_preferences))
            .with_state(state)
    }

    #[tokio::test]
    async fn test_get_preferences_returns_defaults() {
        let app = create_test_app();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/preferences")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let prefs: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(prefs["theme"], "dark");
        assert_eq!(prefs["uiLanguage"], "en");
        assert_eq!(prefs["translationLang"], "it");
        assert_eq!(prefs["fontSize"], 16);
    }

    #[tokio::test]
    async fn test_put_preferences_partial_update() {
        let app = create_test_app();

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/preferences")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "theme": "light" }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let prefs: serde_json::Value = serde_json::from_slice(&body).unwrap();
        // Updated field
        assert_eq!(prefs["theme"], "light");
        // Unchanged fields remain at defaults
        assert_eq!(prefs["uiLanguage"], "en");
        assert_eq!(prefs["translationLang"], "it");
        assert_eq!(prefs["fontSize"], 16);
    }

    #[tokio::test]
    async fn test_put_preferences_empty_body_is_noop() {
        let app = create_test_app();

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/preferences")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let prefs: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(prefs["theme"], "dark");
        assert_eq!(prefs["uiLanguage"], "en");
        assert_eq!(prefs["translationLang"], "it");
        assert_eq!(prefs["fontSize"], 16);
    }

    #[tokio::test]
    async fn test_put_preferences_invalid_font_size_too_small() {
        let app = create_test_app();

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/preferences")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "fontSize": 8 }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let err: ApiError = serde_json::from_slice(&body).unwrap();
        assert!(err.error.contains("fontSize"));
    }

    #[tokio::test]
    async fn test_put_preferences_invalid_font_size_too_large() {
        let app = create_test_app();

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/preferences")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "fontSize": 48 }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let err: ApiError = serde_json::from_slice(&body).unwrap();
        assert!(err.error.contains("fontSize"));
    }

    #[tokio::test]
    async fn test_put_preferences_invalid_font_size_not_integer() {
        let app = create_test_app();

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/preferences")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "fontSize": "big" }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let err: ApiError = serde_json::from_slice(&body).unwrap();
        assert!(err.error.contains("fontSize"));
    }

    #[tokio::test]
    async fn test_put_preferences_invalid_theme() {
        let app = create_test_app();

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/preferences")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "theme": "neon" }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let err: ApiError = serde_json::from_slice(&body).unwrap();
        assert!(err.error.contains("theme"));
    }

    #[tokio::test]
    async fn test_put_preferences_invalid_ui_language() {
        let app = create_test_app();

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/preferences")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "uiLanguage": "fr" }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let err: ApiError = serde_json::from_slice(&body).unwrap();
        assert!(err.error.contains("uiLanguage"));
    }

    #[tokio::test]
    async fn test_put_preferences_invalid_translation_lang() {
        let app = create_test_app();

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/preferences")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "translationLang": "xx" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let err: ApiError = serde_json::from_slice(&body).unwrap();
        assert!(err.error.contains("translationLang"));
    }

    #[tokio::test]
    async fn test_put_preferences_all_fields_valid() {
        let app = create_test_app();

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/preferences")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "theme": "sepia",
                            "uiLanguage": "it",
                            "translationLang": "fr",
                            "fontSize": 24
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let prefs: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(prefs["theme"], "sepia");
        assert_eq!(prefs["uiLanguage"], "it");
        assert_eq!(prefs["translationLang"], "fr");
        assert_eq!(prefs["fontSize"], 24);
    }
}
