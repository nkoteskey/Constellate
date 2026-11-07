# The Constellate desktop app

One install that runs Constellate, joins the x0x network, and, only when you turn it on,
lends your computer's spare time to open problems.

## What's inside

| Part | What it does |
|---|---|
| The window | The Constellate app, served from your own computer at `127.0.0.1:4747`. |
| x0x (`x0xd` 0.48.1) | The network. The app starts its own copy in its own folder, on random ports, with self-update off; it checks it every 20 seconds and restarts it if it stops. If x0x can't start, Constellate keeps working on this computer only and says so. |
| Lend this computer | One switch on the Compute page. It runs a free, open model sized to the machine, only while it's idle and plugged in, with the heat, battery and hours limits on the same page. |
| Connect agents | One click adds Constellate to Claude Desktop or Cursor (a backup of their settings file is kept). Claude Code gets a command to copy. Agents use the Constellate inside the app, so nothing else needs installing. |
| Tray icon | Open, lend or stop lending, open at login, show logs, quit. Closing the window while lending keeps it running in the tray. |

Your data stays where the command-line version keeps it (`~/.constellate`), so the app and
the CLI share one identity. The app's own settings, logs and x0x instance live in the
system's app-data folder (`Constellate/`).

## What it needs from you

- **Free models:** [Ollama](https://ollama.com/download). The app links to it and downloads
  the model you pick, with progress, only when you click. Hosted models (any provider) work
  without Ollama; add a key on the Compute page.
- **Nothing else.** Node, git and the terminal aren't needed.

## Building and releasing

CI (`.github/workflows/desktop.yml`) builds and tests the Linux app on every pull request
that touches it, including a run against the real bundled x0xd. A version tag (`v0.1.0`)
or a manual run builds every installer:

| OS | Files |
|---|---|
| macOS (Apple silicon and Intel) | `.dmg` and `.zip` |
| Windows | `Constellate-Setup-….exe` |
| Linux | `.AppImage` and `.deb` |

A tag also drafts a GitHub release with the installers and `SHA256SUMS.txt`. The owner
reviews and publishes it; nothing is published automatically.

Local build, from the repository root:

```
npm ci && npm run build
cd desktop && npm ci && cd ..
node desktop/scripts/stage.mjs          # app shell + Constellate + production dependencies
node desktop/scripts/fetch-x0x.mjs      # the pinned x0xd for this OS, checked against committed SHA-256 sums
cd desktop && npx electron-builder --config builder.config.cjs
```

`npm start` in `desktop/` runs the app from source (it uses `../dist`; set
`CONSTELLATE_X0XD` to an x0xd binary to join the network).

## Needs a human before a smooth public release

- **Code signing.** Builds are unsigned on Windows and ad-hoc signed on macOS, so the
  first launch shows a warning: macOS needs right-click → Open; Windows SmartScreen needs
  "More info → Run anyway". To remove the warnings, add an Apple Developer ID
  (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`) and a Windows code-signing certificate as repository secrets. The
  workflow already uses them when present.
- **Automatic updates** are off until builds are signed; new versions come from the
  releases page.
- **x0x on real networks.** Tests use a stand-in daemon and the real x0xd offline. The
  first run on a home network (NAT traversal, peers) should be checked on a real machine.
- **Upgrading x0x** is a reviewed change: update `X0X_VERSION` and the five SHA-256 sums
  in `desktop/scripts/fetch-x0x.mjs`, and `X0X_VERSION` in `desktop/lib/x0x.mjs`.
