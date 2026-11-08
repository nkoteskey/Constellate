// Builds data/seed/tldr-pages.json: command usage from tldr-pages (CC BY 4.0), with credit.
//
//   node scripts/import-tldr.mjs <tldr clone>      (needs `npm run build` first)
//
// <tldr clone> is a git clone of https://github.com/tldr-pages/tldr (pages/common and pages/linux are enough).
// Only the commands below are taken: the ones agents run into while building and fixing software. Every entry
// keeps its source page pinned to the clone's commit, the licence and a notice of what was changed, and must pass
// Constellate's privacy check as written (or it's left out and listed).
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const { scrub } = await import(pathToFileURL(join(ROOT, 'dist', 'privacy', 'scrub.js')).href);
const clone = process.argv[2];
if (!clone || !existsSync(join(clone, 'pages', 'common'))) { console.error('usage: node scripts/import-tldr.mjs <tldr clone>'); process.exit(2); }
const commit = execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

// The commands agents most often hit while building, testing, packaging and running software.
const COMMANDS = [
  // version control and hosting
  'git', 'git-clone', 'git-commit', 'git-rebase', 'git-merge', 'git-stash', 'git-reset', 'git-checkout', 'git-switch', 'git-branch', 'git-log', 'git-diff', 'git-push', 'git-pull', 'git-fetch', 'git-cherry-pick', 'git-bisect', 'git-worktree', 'git-submodule', 'git-tag', 'git-remote', 'git-config', 'git-restore', 'git-revert', 'git-reflog', 'git-blame', 'git-clean', 'gh',
  // JavaScript and TypeScript
  'node', 'npm', 'npx', 'npm-install', 'npm-run', 'npm-ci', 'pnpm', 'yarn', 'bun', 'deno', 'tsc', 'nvm',
  // Python
  'python', 'pip', 'pip-install', 'pipx', 'uv', 'poetry', 'pytest', 'virtualenv', 'conda',
  // Rust, Go, C and the JVM
  'cargo', 'cargo-build', 'cargo-test', 'cargo-add', 'cargo-clippy', 'rustup', 'rustc', 'go', 'go-build', 'go-test', 'go-mod', 'gcc', 'clang', 'make', 'cmake', 'ninja', 'mvn', 'gradle', 'java',
  // containers and deployment
  'docker', 'docker-run', 'docker-build', 'docker-compose', 'docker-exec', 'docker-logs', 'docker-ps', 'podman', 'kubectl', 'kubectl-logs', 'kubectl-get', 'kubectl-describe', 'helm', 'terraform',
  // shell, files and text
  'bash', 'find', 'grep', 'rg', 'sed', 'awk', 'xargs', 'jq', 'tar', 'zip', 'unzip', 'gzip', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'chmod', 'chown', 'ln', 'du', 'df', 'tee', 'sort', 'uniq', 'head', 'tail', 'diff', 'patch', 'env', 'export', 'which', 'timeout', 'watch', 'tmux',
  // processes, ports and the system
  'ps', 'kill', 'pkill', 'lsof', 'top', 'htop', 'nohup', 'systemctl', 'journalctl', 'ulimit', 'strace', 'netstat', 'ss', 'nc', 'dig', 'openssl', 'crontab', 'sudo', 'apt', 'brew',
  // databases
  'psql', 'pg_dump', 'sqlite3', 'redis-cli', 'mysql',
];

function parse(md) {
  const lines = md.split('\n');
  const title = (lines.find((l) => l.startsWith('# ')) ?? '').slice(2).trim();
  const desc = lines.filter((l) => l.startsWith('> ') && !/^> More information:/.test(l) && !/^> (This command is an alias|See also)/.test(l)).map((l) => l.slice(2).trim()).join(' ');
  const examples = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('- ')) continue;
    const code = lines.slice(i + 1).find((l) => l.startsWith('`'));
    if (!code) continue;
    // Changed: {{placeholders}} written as <placeholders>, and tldr's [l]etter hints and [-s|--long] option pairs written plainly.
    const what = lines[i].slice(2).replace(/:$/, '').replace(/\[(\w)\]/g, '$1').trim();
    const cmd = code.replace(/^`|`$/g, '').replace(/\{\{\[([^|\]]+)\|([^\]]+)\]\}\}/g, '$2').replace(/\{\{([^}]+)\}\}/g, '<$1>');
    examples.push({ what, cmd });
  }
  return { title, description: desc, examples };
}

const out = [], left = [];
for (const name of COMMANDS) {
  const platform = ['common', 'linux'].find((p) => existsSync(join(clone, 'pages', p, `${name}.md`)));
  if (!platform) { left.push({ command: name, reason: 'no page' }); continue; }
  const p = parse(readFileSync(join(clone, 'pages', platform, `${name}.md`), 'utf8'));
  if (!p.examples.length) { left.push({ command: name, reason: 'no examples' }); continue; }
  const entry = {
    command: p.title || name, platform, description: p.description, examples: p.examples,
    license: 'CC-BY-4.0', attribution: 'tldr-pages team and contributors',
    notice: 'From tldr-pages; placeholders written as <name>, option hints written plainly, the "More information" line left out.',
    source: { repo: 'tldr-pages/tldr', commit, path: `pages/${platform}/${name}.md`, url: `https://github.com/tldr-pages/tldr/blob/${commit}/pages/${platform}/${name}.md` },
  };
  // Checked as it will be signed (src/seed/tldr.ts joins each example as "what: command").
  const check = scrub({ description: entry.description, examples: entry.examples, answer: [entry.description, ...entry.examples.map((e) => `${e.what}: ${e.cmd}`)].join('\n') }, { level: 'strict' });
  if (!check.ok) { left.push({ command: name, reason: `privacy check: ${[...new Set(check.findings.map((f) => f.type))].join(', ')}` }); continue; }
  out.push(entry);
}
writeFileSync(join(ROOT, 'data', 'seed', 'tldr-pages.json'), JSON.stringify({ source: 'https://github.com/tldr-pages/tldr', commit, license: 'CC-BY-4.0', pages: out, left_out: left }, null, 1) + '\n');
console.log(`tldr-pages at ${commit.slice(0, 12)}: ${out.length} commands; left out ${left.length}: ${left.map((l) => `${l.command} (${l.reason})`).join(', ')}`);
