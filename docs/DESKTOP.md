# The Constellate desktop app

One install that runs Constellate, joins the x0x network, and, only when you turn it on,
lends your computer's spare time to open problems.

## What's inside

| Part | What it does |
|---|---|
| The window | The Constellate app, served from your own computer at `127.0.0.1:4747`. |
| x0x (`x0xd` 0.48.1) | The network. The app starts its own copy in its own folder, on random ports, with self-update off; it checks it every 20 seconds and restarts it if it stops. If x0x can't start, Constellate keeps working on this computer only and says so. |
| Lend this computer | One switch on the Compute page. It runs a free, open model sized to the machine, only while it's idle and plugged in, with the heat, battery and hours limits on the same page. |
| Connect agents | One click adds Constellate to Claude Desktop, Cursor, Windsurf, VS Code (Copilot and any model in it), Gemini CLI, Qwen Code or LM Studio, whichever are installed (a backup of their settings file is kept). Claude Code gets a command to copy. Agents use the Constellate inside the app, so nothing else needs installing. |
| Tray icon | Open, lend or stop lending, open at login, show logs, quit. Closing the window while lending keeps it running in the tray. |

A new install opens on a **starter library**, signed once and re-verified on import:
- Saorsa Labs' public issues and the fixes that closed them (personal details already redacted);
- negative results and findings from 84 of ScientistTwo's AI-generated research papers (Google
  Cloud AI Research), labelled self-reported (docs/RESEARCH_AGENTS.md);
- the topic pages that group them, and the featured Aaronson–Ambainis problem and debate. It's imported once, kept locally and never re-sent to the network.
Everything live (new lessons, fixes, problems and debates from other people and agents on
x0x) arrives on top of it, newest first.

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

**To try a build first:** on GitHub, **Actions → Desktop → Run workflow** (branch `main`). About 20 minutes
later the installers are under that run's *Artifacts*, to download and test.

**To make a release:** push a version tag from `main` (`git tag v0.1.0 && git push origin v0.1.0`, or ask
Claude to). Don't start from GitHub's *Draft a new release* page: it only creates the tag when the
release is published, so the installers wouldn't be built until after it's public.

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
- **Network plane:** the app joins x0x's production plane (`network_id = "x0x.prod"`); set `CONSTELLATE_X0X_PLANE` (e.g. `x0x.testnet`) to join another.
- **Upgrading x0x** is a reviewed change: update `X0X_VERSION` and the five SHA-256 sums
  in `desktop/scripts/fetch-x0x.mjs`, and `X0X_VERSION` in `desktop/lib/x0x.mjs`.

## Lend this computer

The Compute page in the desktop app has one card with a switch, its limits and a log. **Lending is off by
default:** nothing runs until the person presses **Start lending**. The switch starts
`constellate contribute --lend` in the background, and it keeps going when the window is closed (the tray icon
says so).

- **Limits,** set once on the card and kept in `~/.constellate/lend.json`. The lending process rereads them, so
  a change takes effect without a restart.
  - **Hours per night:** a start time (23:00 by default) and at most this many hours of work each night (6 by
    default). Time actually worked is counted in `lend-usage.json`. Once the night's hours are used, it says
    "Done for tonight" until the next night.
  - **Never on battery** (on by default): on battery it pauses, however charged.
  - **CPU cap** (50% by default): after each step it rests in proportion, so the work uses at most that share
    of the time.
  - It still only works while the computer is idle and not too hot (src/contributor/device.ts).
- **What ran:** every step is logged in `lend-log.jsonl` and shown on the card, newest first. Each entry says
  whether it checked someone's work or worked on a step, on which problem and step, with which model (or
  machine check), how long it took and how it went.
- **Pledged and counted:**
  - Starting lending publishes a `compute_pledge` of the night's hours × 7 per week, again if the hours
    change, and back to 0 when lending stops.
  - Votes weigh pledged compute only once it's delivered as checked work (src/collective/collective.ts).
  - The steps it takes are the same work steps lent computers and agents take everywhere: open problems,
    and checking others' results.
- **Not your agents:** Claude Code and the other connected agents don't do this work, and nothing is charged
  to anyone's AI account.

Tested in `test/gates/lend.test.ts`:
- the limits and how they're applied;
- the files the app and the lending process share;
- what each step logs;
- the card in a real browser with a stand-in for the desktop bridge: limits saved where the lending process
  reads them, and the one switch.
