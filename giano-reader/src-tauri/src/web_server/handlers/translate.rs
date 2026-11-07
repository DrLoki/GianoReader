use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::web_server::models::ApiError;
use crate::web_server::translator::{translate, translate_v2, TranslateError};

use super::books::AppState;

/// Translation target languages (code, native name). Single source of truth for
/// the server; kept identical to the desktop picker (`FLAG_MAP` in main.js)
/// and to the PWA offline list (`STATIC_LANGUAGES` in web-client translate.ts).
pub const LANGUAGES: &[(&str, &str)] = &[
    ("it", "Italiano"),
    ("en", "English"),
    ("fr", "Français"),
    ("de", "Deutsch"),
    ("es", "Español"),
    ("pt", "Português"),
    ("ru", "Русский"),
    ("zh", "中文"),
    ("ja", "日本語"),
    ("ko", "한국어"),
    ("ar", "العربية"),
    ("fa", "فارسی"),
    ("hi", "हिन्दी"),
    ("bn", "বাংলা"),
    ("id", "Bahasa Indonesia"),
    ("th", "ไทย"),
    ("vi", "Tiếng Việt"),
    ("fil", "Filipino"),
    ("sq", "Shqip"),
    ("sv", "Svenska"),
    ("uk", "Українська"),
    ("sl", "Slovenščina"),
];

pub fn is_supported_lang(code: &str) -> bool {
    LANGUAGES.iter().any(|(c, _)| *c == code)
}

pub fn supported_lang_codes() -> Vec<&'static str> {
    LANGUAGES.iter().map(|(c, _)| *c).collect()
}

/// Upper bounds for a single translate request (the PWA sends at most 12
/// paragraphs at a time); larger requests are rejected to limit abuse.
pub const MAX_TEXTS_PER_REQUEST: usize = 100;
pub const MAX_CHARS_PER_REQUEST: usize = 50_000;

#[derive(Deserialize)]
pub struct TranslateRequest {
    pub texts: Option<serde_json::Value>,
    #[serde(alias = "source_lang", rename = "sourceLang")]
    pub source_lang: Option<String>,
    #[serde(alias = "target_lang", rename = "targetLang")]
    pub target_lang: Option<String>,
    pub mode: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct TranslateResponse {
    pub translations: Vec<String>,
}

#[derive(Serialize, Deserialize)]
pub struct Language {
    pub code: String,
    pub name: String,
}

/// POST /api/translate
///
/// Translates an array of text strings from `sourceLang` to `targetLang`.
///
/// Validates:
/// - `texts` must be present and a JSON array of strings
/// - `sourceLang` and `targetLang` must be present
/// - `targetLang` must be one of the supported BCP-47 codes (`LANGUAGES`)
///
/// Returns 200 with `{ translations: [...] }` on success.
/// Returns 400 on validation failure.
/// Returns 502 on translation engine network failure.
/// Returns 500 on translation engine not configured.
pub async fn post_translate(
    State(state): State<Arc<AppState>>,
    Json(body): Json<TranslateRequest>,
) -> impl IntoResponse {
    // Validate sourceLang
    let source_lang = match body.source_lang {
        Some(ref lang) if !lang.is_empty() => lang.clone(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: "sourceLang: required".to_string(),
                }),
            )
                .into_response();
        }
    };

    // Validate targetLang
    let target_lang = match body.target_lang {
        Some(ref lang) if !lang.is_empty() => lang.clone(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: "targetLang: required".to_string(),
                }),
            )
                .into_response();
        }
    };

    // Validate targetLang is a supported language
    if !is_supported_lang(&target_lang) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: format!(
                    "targetLang: '{}' is not a supported language code",
                    target_lang
                ),
            }),
        )
            .into_response();
    }

    // Validate texts field
    let texts_value = match body.texts {
        Some(val) => val,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: "texts: required".to_string(),
                }),
            )
                .into_response();
        }
    };

    // texts must be an array
    let texts_array = match texts_value.as_array() {
        Some(arr) => arr,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error: "texts: must be an array".to_string(),
                }),
            )
                .into_response();
        }
    };

    // Each element must be a string
    let mut texts: Vec<String> = Vec::with_capacity(texts_array.len());
    for (i, item) in texts_array.iter().enumerate() {
        match item.as_str() {
            Some(s) => texts.push(s.to_string()),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ApiError {
                        error: format!("texts[{}]: must be a string", i),
                    }),
                )
                    .into_response();
            }
        }
    }

    let total_chars: usize = texts.iter().map(|t| t.chars().count()).sum();
    if texts.len() > MAX_TEXTS_PER_REQUEST || total_chars > MAX_CHARS_PER_REQUEST {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(ApiError {
                error: format!(
                    "texts: at most {} items and {} characters per request",
                    MAX_TEXTS_PER_REQUEST, MAX_CHARS_PER_REQUEST
                ),
            }),
        )
            .into_response();
    }

    // Empty array short-circuit: return 200 with empty translations
    if texts.is_empty() {
        return (
            StatusCode::OK,
            Json(TranslateResponse {
                translations: vec![],
            }),
        )
            .into_response();
    }

    // Call the translation engine based on mode
    let mode = body.mode.as_deref().unwrap_or("free");

    let result = if mode == "basic" {
        // Load Google Cloud API key from preferences
        let prefs = match state.store.get_preferences() {
            Ok(p) => p,
            Err(_) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiError {
                        error: "Failed to load preferences".to_string(),
                    }),
                )
                    .into_response();
            }
        };

        let api_key = match prefs.gcloud_api_key {
            Some(ref key) if !key.is_empty() => key.clone(),
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ApiError {
                        error: "Google Cloud API Key not configured. Set it in preferences."
                            .to_string(),
                    }),
                )
                    .into_response();
            }
        };

        translate_v2(texts, &source_lang, &target_lang, &api_key).await
    } else {
        translate(texts, &source_lang, &target_lang).await
    };

    match result {
        Ok(translations) => (
            StatusCode::OK,
            Json(TranslateResponse { translations }),
        )
            .into_response(),
        Err(TranslateError::NetworkFailure(msg)) => (
            StatusCode::BAD_GATEWAY,
            Json(ApiError {
                error: format!("Translation service unavailable: {}", msg),
            }),
        )
            .into_response(),
        Err(TranslateError::NotConfigured) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: "Translation engine not initialised".to_string(),
            }),
        )
            .into_response(),
        Err(TranslateError::InvalidCredentials(msg)) => (
            StatusCode::FORBIDDEN,
            Json(ApiError {
                error: format!("Invalid Google Cloud credentials: {}", msg),
            }),
        )
            .into_response(),
        Err(TranslateError::RateLimited) => (
            StatusCode::TOO_MANY_REQUESTS,
            Json(ApiError {
                error: "Google Cloud Translation quota exceeded. Try again later.".to_string(),
            }),
        )
            .into_response(),
    }
}

/// GET /api/translate/languages
///
/// Returns the list of supported translation languages.
pub async fn get_languages() -> impl IntoResponse {
    let languages: Vec<Language> = LANGUAGES
        .iter()
        .map(|(code, name)| Language { code: code.to_string(), name: name.to_string() })
        .collect();

    (StatusCode::OK, Json(languages))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        routing::{get, post},
        Router,
    };
    use tower::ServiceExt;
    use serde_json::json;

    fn create_test_app() -> Router {
        use crate::web_server::persistence::PersistenceStore;
        use std::path::PathBuf;

        let store = PersistenceStore::open(std::env::temp_dir().join(format!(
            "giano-test-translate-{}",
            uuid::Uuid::new_v4()
        )))
        .unwrap();

        let state = Arc::new(AppState::new(PathBuf::from(std::env::temp_dir()), store));

        Router::new()
            .route("/api/translate", post(post_translate))
            .route("/api/translate/languages", get(get_languages))
            .with_state(state)
    }

    #[tokio::test]
    async fn test_get_languages_matches_shared_list() {
        let app = create_test_app();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/translate/languages")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let languages: Vec<Language> = serde_json::from_slice(&body).unwrap();
        assert_eq!(languages.len(), LANGUAGES.len());
        assert_eq!(languages.len(), 22);
        assert_eq!(languages[0].code, "it");
        assert_eq!(languages[0].name, "Italiano");
        assert!(languages.iter().any(|l| l.code == "fa"));
    }

    #[tokio::test]
    async fn test_translate_missing_texts() {
        let app = create_test_app();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/translate")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "sourceLang": "en", "targetLang": "it" }).to_string(),
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
        assert!(err.error.contains("texts"));
    }

    #[tokio::test]
    async fn test_translate_texts_not_array() {
        let app = create_test_app();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/translate")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "texts": "not an array", "sourceLang": "en", "targetLang": "it" })
                            .to_string(),
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
        assert!(err.error.contains("texts"));
    }

    #[tokio::test]
    async fn test_translate_texts_element_not_string() {
        let app = create_test_app();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/translate")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "texts": ["hello", 42], "sourceLang": "en", "targetLang": "it" })
                            .to_string(),
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
        assert!(err.error.contains("texts[1]"));
    }

    #[tokio::test]
    async fn test_translate_missing_source_lang() {
        let app = create_test_app();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/translate")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "texts": ["hello"], "targetLang": "it" }).to_string(),
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
        assert!(err.error.contains("sourceLang"));
    }

    #[tokio::test]
    async fn test_translate_missing_target_lang() {
        let app = create_test_app();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/translate")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "texts": ["hello"], "sourceLang": "en" }).to_string(),
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
        assert!(err.error.contains("targetLang"));
    }

    #[tokio::test]
    async fn test_translate_unsupported_target_lang() {
        let app = create_test_app();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/translate")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "texts": ["hello"], "sourceLang": "en", "targetLang": "xx" })
                            .to_string(),
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
        assert!(err.error.contains("targetLang"));
    }

    #[tokio::test]
    async fn test_translate_empty_texts_returns_empty_translations() {
        let app = create_test_app();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/translate")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "texts": [], "sourceLang": "en", "targetLang": "it" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let resp: TranslateResponse = serde_json::from_slice(&body).unwrap();
        assert_eq!(resp.translations.len(), 0);
    }
}
