# Third-party data in the starter library: notices

Constellate's starter library includes openly licensed public agent skills (SKILL.md files), imported by
`scripts/import-skills.mjs` into `data/seed/agent-skills.json` and seeded by `src/seed/agent-skills.ts`.
Each signed skill record names its source (pinned to a commit or tag), its licence and what Constellate changed.

Licence texts: `Apache-2.0.txt` (Apache License 2.0) and the MIT licences with their copyright lines
(`MIT-notion-skills.txt`, `MIT-vercel-deploy.txt`, `MIT-x0x.txt`, `MIT-ant-sdk.txt`).

**What was changed, for every skill:** the YAML header was removed (name and description are kept as fields);
only the SKILL.md text is included, not the scripts, references or assets the skill bundles, which stay at the
source link; three long skills were shortened, with a pointer to the full text. The x0x and Autonomi skills had
small edits so they pass Constellate's privacy check (see each record's notice). Constellate names people only
by handle or organisation, so author names and contact addresses are not carried over.

**Also preserved:** OpenAI's `playwright-interactive` skill carries a NOTICE about Playwright icon assets
(Copyright (c) Microsoft Corporation, Apache-2.0). Those assets are not included here.

## Sources

- **Anthropic**, [anthropics/skills](https://github.com/anthropics/skills) at `2c5958ecac7cee2b583967a2c4981d0f4a75c579` (Apache-2.0): 13 skills: algorithmic-art, canvas-design, discernment-nudge, docx, frontend-design, mcp-builder, pptx, skill-creator, slack-gif-creator, theme-factory, web-artifacts-builder, webapp-testing, xlsx.
- **Hugging Face**, [huggingface/skills](https://github.com/huggingface/skills) at `25910b3d0ba31a2ba102f901cdc9e008c278a69c` (Apache-2.0): 19 skills: hf-cli, hf-cloud-aws-context-discovery, hf-cloud-python-env-setup, hf-cloud-sagemaker-deployment-planner, hf-cloud-sagemaker-iam-preflight, hf-cloud-sagemaker-production-defaults, hf-cloud-serving-image-selection, hf-mcp, hf-mem, huggingface-best, huggingface-community-evals, huggingface-gradio, huggingface-local-models, huggingface-papers, huggingface-tool-builder, huggingface-trackio, huggingface-zerogpu, train-sentence-transformers, trl-training.
- **OpenAI**, [openai/skills](https://github.com/openai/skills) at `49f948faa9258a0c61caceaf225e179651397431` (Apache-2.0, MIT): 29 skills: aspnet-core, chatgpt-apps, cli-creator, cloudflare-deploy, define-goal, gh-address-comments, gh-fix-ci, hatch-pet, imagegen, jupyter-notebook, linear, migrate-to-codex, notion-knowledge-capture, notion-meeting-intelligence, notion-research-documentation, notion-spec-to-implementation, openai-docs, pdf, playwright-interactive, screenshot, security-best-practices, security-threat-model, sentry, skill-creator, speech, transcribe, vercel-deploy, winui-app, yeet.
- **Saorsa Labs**, [saorsa-labs/x0x](https://github.com/saorsa-labs/x0x) at `v0.48.1` (MIT OR Apache-2.0): 1 skill: x0x.
- **Autonomi**, [WithAutonomi/ant-sdk](https://github.com/WithAutonomi/ant-sdk) at `3184f88c34779d6d449f2c4d76bfae77e4d2aa3e` (MIT OR Apache-2.0): 1 skill: Building apps on the Autonomi network.

## Left out

- Skills without an open licence we can redistribute under (for example OpenAI's Figma skills and Anthropic's doc-coauthoring).
- One organisation's own brand, internal or course material, installers that change the agent's own setup, and templates.
- Skills that fail the privacy check as written (example emails, people's names, or text that reads as a credential).

# tldr-pages: command usage (CC BY 4.0)

Constellate's starter library includes command usage from [tldr-pages](https://github.com/tldr-pages/tldr),
copyright © 2014 to present the tldr-pages team and contributors, licensed under the Creative Commons
Attribution 4.0 International License (`CC-BY-4.0.txt`). `scripts/import-tldr.mjs` imports it into
`data/seed/tldr-pages.json`, pinned to commit `c8498c5e05b396098d1d9b1d71e2290a32559f27`.
`src/seed/tldr.ts` seeds it as one answer record per command.

**Every record carries its licence:** `license: CC-BY-4.0`, the attribution, a link to its source page at that
commit, and a notice of what was changed.

**What was changed:**
- placeholders are written as `<name>` instead of `{{name}}`;
- the letter hints (`[c]reate`) and option pairs (`[-C|--directory]`) are written plainly;
- the "More information" line is left out;
- only 137 of the commands agents most often hit are included, not all of tldr-pages.

**Left out:** five pages whose examples didn't pass Constellate's privacy check as written. `git-config`
(an example email address), `ssh` and `ss` (private network addresses), `dig` (a public address) and
`redis-cli` (an example password). `data/seed/tldr-pages.json` lists them under `left_out`.
