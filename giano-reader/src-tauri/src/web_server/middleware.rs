use axum::{
    body::Body,
    extract::{ConnectInfo, State},
    http::{HeaderMap, Request, Response, StatusCode},
    middleware::Next,
};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::web_server::models::{ApiError, ServerState};
use super::handlers::books::AppState;

// ── Brute-force protection ───────────────────────────────────────────────────

/// Failed attempts allowed from a single IP before it is locked out.
pub const MAX_AUTH_FAILURES: u32 = 10;
/// How long an IP stays locked out after exceeding `MAX_AUTH_FAILURES`.
pub const AUTH_LOCKOUT: Duration = Duration::from_secs(5 * 60);

/// Tracks failed password attempts per client IP.
#[derive(Default)]
pub struct AuthGuard {
    failures: Mutex<HashMap<IpAddr, (u32, Instant)>>,
}

impl AuthGuard {
    /// True if `ip` exceeded the failure budget within the lockout window.
    pub fn is_locked(&self, ip: Option<IpAddr>) -> bool {
        let Some(ip) = ip else { return false };
        let mut map = self.failures.lock().unwrap();
        match map.get(&ip) {
            Some((count, since)) if since.elapsed() < AUTH_LOCKOUT => *count >= MAX_AUTH_FAILURES,
            Some(_) => {
                map.remove(&ip);
                false
            }
            None => false,
        }
    }

    pub fn record_failure(&self, ip: Option<IpAddr>) {
        let Some(ip) = ip else { return };
        let mut map = self.failures.lock().unwrap();
        let entry = map.entry(ip).or_insert((0, Instant::now()));
        if entry.1.elapsed() >= AUTH_LOCKOUT {
            *entry = (0, Instant::now());
        }
        entry.0 += 1;
        entry.1 = Instant::now();
    }

    pub fn record_success(&self, ip: Option<IpAddr>) {
        if let Some(ip) = ip {
            self.failures.lock().unwrap().remove(&ip);
        }
    }
}

/// Compares two secrets in constant time (independent of where they differ
/// and of their lengths) by comparing their SHA-256 digests.
pub fn secrets_equal(a: &str, b: &str) -> bool {
    let da = Sha256::digest(a.as_bytes());
    let db = Sha256::digest(b.as_bytes());
    da.iter().zip(db.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Outcome of an authorization check against the configured server password.
#[derive(Debug, PartialEq, Eq)]
pub enum AuthOutcome {
    /// No password configured, or the correct one was supplied.
    Allowed,
    /// A password is configured and the request did not supply it.
    Denied,
    /// Too many failed attempts from this IP.
    Locked,
}

/// Extracts the client IP from the request extensions, when the server was
/// started with `into_make_service_with_connect_info` (tests are not).
pub fn client_ip<B>(req: &Request<B>) -> Option<IpAddr> {
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip())
}

/// Checks the `Authorization: Bearer <password>` header against the configured
/// password, updating the brute-force counters.
pub fn check_auth(state: &AppState, headers: &HeaderMap, ip: Option<IpAddr>) -> AuthOutcome {
    let configured_password = state
        .store
        .get_preferences()
        .ok()
        .and_then(|p| p.password);

    // If no password is configured, allow all requests
    let Some(expected) = configured_password else {
        return AuthOutcome::Allowed;
    };

    if state.auth_guard.is_locked(ip) {
        return AuthOutcome::Locked;
    }

    let supplied = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));

    match supplied {
        Some(token) if secrets_equal(token, &expected) => {
            state.auth_guard.record_success(ip);
            AuthOutcome::Allowed
        }
        Some(_) => {
            // Only count actual wrong guesses, not requests without credentials
            state.auth_guard.record_failure(ip);
            AuthOutcome::Denied
        }
        None => AuthOutcome::Denied,
    }
}

/// Builds the JSON error response for a failed `AuthOutcome`.
pub fn auth_error_response(outcome: &AuthOutcome) -> Response<Body> {
    let (status, msg) = match outcome {
        AuthOutcome::Locked => (StatusCode::TOO_MANY_REQUESTS, "too many failed attempts"),
        _ => (StatusCode::UNAUTHORIZED, "unauthorized"),
    };
    let body = serde_json::to_string(&ApiError { error: msg.to_string() }).unwrap();
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap()
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
/// Returns 401 with `{ "error": "unauthorized" }` on mismatch, and 429 after
/// `MAX_AUTH_FAILURES` wrong passwords from the same IP.
pub async fn require_password(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
    next: Next,
) -> Response<Body> {
    let ip = client_ip(&req);
    match check_auth(&state, req.headers(), ip) {
        AuthOutcome::Allowed => next.run(req).await,
        other => auth_error_response(&other),
    }
}

/// Content-Security-Policy for the PWA. Scripts may only come from this
/// origin (no inline scripts), so injected EPUB markup cannot execute code even
/// if it slipped past the HTML sanitiser. Offline translation talks directly
/// to Google or to the user's Cloudflare Worker.
pub const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob: data: https://translate.googleapis.com https://*.workers.dev; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

/// Adds defensive security headers to every response.
pub async fn security_headers(req: Request<Body>, next: Next) -> Response<Body> {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    let set = |h: &mut HeaderMap, k: &'static str, v: &'static str| {
        h.insert(k, axum::http::HeaderValue::from_static(v));
    };
    set(h, "x-content-type-options", "nosniff");
    set(h, "referrer-policy", "no-referrer");
    set(h, "x-frame-options", "DENY");
    set(h, "content-security-policy", CONTENT_SECURITY_POLICY);
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_equal_matches_only_identical() {
        assert!(secrets_equal("abc", "abc"));
        assert!(!secrets_equal("abc", "abd"));
        assert!(!secrets_equal("abc", "abcd"));
        assert!(!secrets_equal("", "a"));
    }

    #[test]
    fn auth_guard_locks_after_max_failures() {
        let guard = AuthGuard::default();
        let ip: Option<IpAddr> = Some("192.168.1.50".parse().unwrap());
        for _ in 0..MAX_AUTH_FAILURES - 1 {
            guard.record_failure(ip);
        }
        assert!(!guard.is_locked(ip));
        guard.record_failure(ip);
        assert!(guard.is_locked(ip));
        // Other IPs are unaffected
        assert!(!guard.is_locked(Some("192.168.1.51".parse().unwrap())));
        guard.record_success(ip);
        assert!(!guard.is_locked(ip));
    }
}
