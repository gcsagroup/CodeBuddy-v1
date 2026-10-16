//! Tool-only MCP entry point. No Agent, model provider, ACP or scheduler dependency.
use anyhow::{bail, Result};
use goose_mcp::{
    common_queries::CommonQueriesServer, mcp_server_runner::serve, AutoVisualiserRouter,
    ComputerControllerServer,
};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [command, tool] if command == "mcp" => match tool.as_str() {
            "commonqueries" => serve(CommonQueriesServer::new()?).await,
            "computercontroller" => serve(ComputerControllerServer::new()).await,
            "autovisualiser" => serve(AutoVisualiserRouter::new()).await,
            _ => bail!("Unknown MCP tool service"),
        },
        _ => bail!("Usage: codebuddy-tools mcp <commonqueries|computercontroller|autovisualiser>"),
    }
}
