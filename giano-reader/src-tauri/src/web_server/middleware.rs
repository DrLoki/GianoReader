use axum::{
    body::Body,
    extract::State,
    http::{Method, Request, Response, StatusCode},
    middleware::Next,
};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

use crate::web_server::models::{ApiError, ServerState};
use super::handlers::books::AppState;

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

/// Middleware that enforces password protection on protected API routes.
///
/// If a password is configured in Preferences, the request must include
/// an `Authorization: Bearer <password>` header with the correct value.
/// If no password is set, all requests pass through freely.
///
/// Returns 401 with `{ "error": "unauthorized" }` on mismatch.
pub async fn require_password(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
    next: Next,
) -> Response<Body> {
    // Load the configured password from the persistence store
    let configured_password = state
        .store
        .get_preferences()
        .ok()
        .and_then(|p| p.password);

    // If no password is configured, allow all requests
    let Some(expected) = configured_password else {
        return next.run(req).await;
    };

    // Extract the Authorization header
    let authorized = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|token| token == expected)
        .unwrap_or(false);

    if !authorized {
        let error = ApiError {
            error: "unauthorized".to_string(),
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
