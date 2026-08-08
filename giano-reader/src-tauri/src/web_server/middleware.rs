use axum::{
    body::Body,
    extract::State,
    http::{Method, Request, Response, StatusCode},
    middleware::Next,
};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

use crate::web_server::models::{ApiError, ServerState};

/// Creates a CORS layer that allows all origins, methods, and headers.
/// Satisfies Requirement 18.6 — cross-origin requests from any device on LAN.
pub fn cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(Any)
}

/// Middleware that returns 401 Unauthorized for all requests when Web Server Mode
/// is inactive (i.e. `ServerState.handle` is `None`).
///
/// Satisfies Requirements 1.4 and 1.5 — while the server is inactive, all REST API
/// endpoints and static asset paths return HTTP 401.
#[allow(dead_code)]
pub async fn require_active_server(
    State(state): State<Arc<ServerState>>,
    req: Request<Body>,
    next: Next,
) -> Response<Body> {
    let is_active = {
        let handle = state.handle.lock().unwrap();
        handle.is_some()
    };

    if !is_active {
        let error = ApiError {
            error: "Web Server Mode is not active".to_string(),
        };
        let body = serde_json::to_string(&error).unwrap();
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
    }

    next.run(req).await
}
