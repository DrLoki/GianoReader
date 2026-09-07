use axum::{routing::{get, post, delete}, Router};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use local_ip_address::local_ip;

pub mod epub_parser;
pub mod handlers;
pub mod middleware;
pub mod models;
pub mod persistence;
pub mod static_files;
pub mod translator;

use handlers::books::AppState;
use models::{ServerHandle, ServerInfo, ServerState};

/// Starts the embedded HTTP server on the given port.
///
/// Binds a `TcpListener` to `0.0.0.0:<port>`, detects the LAN IP for the QR URL,
/// spawns the axum server task with graceful shutdown via `CancellationToken`,
/// and stores the `ServerHandle` in the provided `ServerState`.
///
/// Returns `ServerInfo` on success or an error string if the port is in use.
pub async fn start(
    port: u16,
    server_state: &ServerState,
    app_state: Arc<AppState>,
) -> Result<ServerInfo, String> {
    println!("[web_server] start() called with port {}", port);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    // Bind listener, detect AddrInUse
    let listener = TcpListener::bind(addr).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            format!("Port {} is already in use", port)
        } else {
            format!("Failed to bind to port {}: {}", port, e)
        }
    })?;

    // Detect LAN IP (non-loopback IPv4)
    let lan_ip = local_ip().ok().and_then(|ip| {
        if let std::net::IpAddr::V4(v4) = ip {
            if !v4.is_loopback() {
                Some(v4)
            } else {
                None
            }
        } else {
            None
        }
    });

    let display_ip = lan_ip.unwrap_or(Ipv4Addr::LOCALHOST);
    let lan_url = format!("http://{}:{}", display_ip, port);
    let qr_url = lan_url.clone();

    // Create cancellation token for graceful shutdown
    let token = CancellationToken::new();
    let shutdown_token = token.clone();

    // Build router
    let router = build_router(app_state);

    // Spawn server task with graceful shutdown
    let server_task = tokio::spawn(async move {
        println!("[web_server] Starting on {}", addr);
        if let Err(e) = axum::serve(listener, router.into_make_service())
            .with_graceful_shutdown(shutdown_token.cancelled_owned())
            .await
        {
            eprintln!("[web_server] Server error: {}", e);
        }
        println!("[web_server] Server stopped");
    });

    // Store handle in ServerState
    let handle = ServerHandle {
        shutdown_tx: token,
        server_task,
        port,
        lan_ip,
    };
    *server_state.handle.lock().unwrap() = Some(handle);

    Ok(ServerInfo {
        port,
        lan_url,
        qr_url,
    })
}

/// Stops the embedded HTTP server gracefully.
///
/// Cancels the `CancellationToken` to signal the axum server's `with_graceful_shutdown` future,
/// then waits up to 2 seconds for the server task to finish draining in-flight requests.
/// If the server doesn't stop within 2 seconds, the task is force-aborted,
/// releasing the port immediately.
pub async fn stop(server_state: &ServerState) -> Result<(), String> {
    let handle = {
        let mut guard = server_state.handle.lock().unwrap();
        guard.take()
    };

    match handle {
        Some(h) => {
            // Signal graceful shutdown via CancellationToken
            h.shutdown_tx.cancel();

            // Get abort handle so we can force-kill the task on timeout
            let abort_handle = h.server_task.abort_handle();

            // Wait up to 2 seconds for the server task to complete (drain in-flight requests)
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                h.server_task,
            )
            .await;

            if result.is_err() {
                // Timeout expired — force-abort the task to release the port immediately
                abort_handle.abort();
            }

            Ok(())
        }
        None => Err("Web Server is not running".to_string()),
    }
}

/// Builds the complete axum router with all API routes, CORS middleware, and static file serving.
///
/// - All REST API handlers are mounted under `/api/`
/// - CORS middleware allows cross-origin requests from any LAN device (Requirement 18.6)
/// - Static file service serves the embedded web client at `/` with SPA fallback (Requirement 18.5)
/// - Protected routes (books, bookmarks, state, chapters) require password if configured
/// - Public routes (preferences, translate) are always accessible
pub fn build_router(state: Arc<AppState>) -> Router {
    // Protected routes: require password when configured
    let protected_routes = Router::new()
        // Books
        .route("/books", get(handlers::books::list_books))
        .route("/books/{id}/toc", get(handlers::books::get_toc))
        // Chapters
        .route("/books/{id}/chapter/{chapterIndex}", get(handlers::chapters::get_chapter))
        // Reading state
        .route("/books/{id}/state", get(handlers::state::get_reading_state).put(handlers::state::put_reading_state))
        // Bookmarks
        .route("/books/{id}/bookmarks", get(handlers::bookmarks::list_bookmarks).post(handlers::bookmarks::create_bookmark))
        .route("/books/{id}/bookmarks/{bookmarkId}", delete(handlers::bookmarks::delete_bookmark))
        .layer(axum::middleware::from_fn_with_state(state.clone(), middleware::require_password))
        .with_state(state.clone());

    // Public routes: always accessible (no password needed)
    let public_routes = Router::new()
        // Book covers (loaded via <img> tags which cannot send Authorization headers)
        .route("/books/{id}/cover", get(handlers::books::get_cover))
        // Translate
        .route("/translate", post(handlers::translate::post_translate))
        .route("/translate/languages", get(handlers::translate::get_languages))
        // Preferences
        .route("/preferences", get(handlers::prefs::get_preferences).put(handlers::prefs::put_preferences))
        .with_state(state);

    let api_routes = Router::new()
        .merge(protected_routes)
        .merge(public_routes);

    Router::new()
        .nest("/api", api_routes)
        .fallback_service(static_files::static_file_service())
        .layer(middleware::cors_layer())
}
