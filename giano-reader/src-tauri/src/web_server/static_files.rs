use axum::Router;
use axum_embed::{FallbackBehavior, ServeEmbed};
use rust_embed::RustEmbed;

#[derive(RustEmbed, Clone)]
#[folder = "../../web-client/dist/"]
struct WebClientAssets;

/// Creates an axum service that serves the embedded web client files.
/// Falls back to `index.html` for SPA routing (any non-file path returns index.html with 200).
/// ETag support and correct MIME types are included via axum-embed.
pub fn static_file_service<S: Clone + Send + Sync + 'static>() -> Router<S> {
    let serve = ServeEmbed::<WebClientAssets>::with_parameters(
        Some("index.html".to_owned()),
        FallbackBehavior::Ok,
        Some("index.html".to_owned()),
    );
    Router::new().fallback_service(serve)
}
