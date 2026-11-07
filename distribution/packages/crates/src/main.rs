//! Runs the Constellate MCP server (published on npm) for Rust users.
use std::process::{exit, Command};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let status = Command::new("npx").args(["-y", "constellate-mcp", "mcp"]).args(&args).status();
    match status {
        Ok(s) => exit(s.code().unwrap_or(1)),
        Err(_) => {
            eprintln!("Constellate needs Node.js 22+ (npx was not found on PATH).");
            exit(1);
        }
    }
}
