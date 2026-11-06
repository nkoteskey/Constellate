"""Run the Constellate MCP server (published on npm) from Python environments."""
import os
import shutil
import sys


def main() -> None:
    npx = shutil.which("npx")
    if not npx:
        sys.exit("Constellate needs Node.js 22+ (npx was not found on PATH).")
    os.execv(npx, [npx, "-y", "constellate-mcp", "mcp", *sys.argv[1:]])


if __name__ == "__main__":
    main()
