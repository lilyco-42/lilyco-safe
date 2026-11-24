use std::net::SocketAddr;
use std::path::Path;

use relay_server::{build_admin_app, init_state, shutdown_signal};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cfg_path = std::env::var("RELAY_CONFIG").unwrap_or_else(|_| "./config/gateway.toml".into());
    let state = init_state(Path::new(&cfg_path)).await?;
    let bind = std::env::var("RELAY_ADMIN_BIND").unwrap_or_else(|_| "0.0.0.0:8092".into());
    let app = build_admin_app(state);
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    println!("relay-admin (Control Plane · /api/v1/* & Hot Web UI) listening on http://{bind}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}
