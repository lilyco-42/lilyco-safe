use std::path::Path;
use std::time::Duration;

use relay_server::{init_state, shutdown_signal};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cfg_path = std::env::var("RELAY_CONFIG").unwrap_or_else(|_| "./config/gateway.toml".into());
    let interval_secs: u64 = std::env::var("RELAY_WORKER_INTERVAL_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(300)
        .max(30);
    let state = init_state(Path::new(&cfg_path)).await?;
    println!("relay-worker (Background Probe & Model Sync) started, interval={interval_secs}s");

    let mut ticker = tokio::time::interval(Duration::from_secs(interval_secs));
    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                if let Ok(channels) = state.ledger.list_channels().await {
                    for rec in channels.into_iter().filter(|c| c.meta.enabled) {
                        if let Ok(ch) = state.ledger.get_live_channel(&rec.id).await {
                            let probe = state.router.probe_channel(&ch).await;
                            let added = state.router.sync_channel_models(&ch).await.unwrap_or(0);
                            println!(
                                "[worker] channel={} ok={} latency={}ms models={} synced_new={} balance={}",
                                ch.id, probe.ok, probe.latency_ms, probe.models_count, added, probe.balance_text
                            );
                        }
                    }
                }
            }
            () = &mut shutdown => {
                println!("relay-worker received shutdown signal, exiting cleanly");
                break;
            }
        }
    }
    Ok(())
}
