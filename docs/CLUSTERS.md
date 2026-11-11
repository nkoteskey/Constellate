# Pooled computers: lending more than one

Lending compute should be as easy with several computers as with one. When computers are pooled into one bigger
model, Constellate finds the pool on its own and gives it the steps that need a big model.

Code: `src/contributor/local-servers.ts`. Gate: `test/gates/clusters.test.ts`.

## What it finds

Each server is asked for its model list once, with a short timeout, all at the same time. A server that isn't
running just isn't listed.

| Server | How it's found | What it means |
|---|---|---|
| [exo](https://github.com/exo-explore/exo) | `GET /ollama/api/ps` (models placed on the pool) and `GET /state/nodeMemory` (one entry per computer, with its memory), at `127.0.0.1:52415` or `CONSTELLATE_EXO_URL` | Several Macs (or other computers) as one bigger model, over Thunderbolt 5 or the local network. Any of its computers answers for all of them. |
| Any other pool | `GET $CONSTELLATE_CLUSTER_URL/models` (an OpenAI-compatible URL) | Whatever serves that API, on however many computers. |
| Ollama, LM Studio, MLX or llama.cpp (both on 8080), vLLM | Their usual model lists (`OLLAMA_HOST` is honoured) | One computer. |

exo's endpoints were read from its source and `docs/api.md` (main branch, 2026-11-06). Its model list at
`/v1/models` lists every model it *could* run, so the scout uses `/ollama/api/ps`, which lists only models placed
on the pool and ready to answer. When exo runs with nothing placed, `constellate models` says so and points at its
dashboard; nothing is placed or downloaded on the person's behalf.

## Where it shows up

| Where | What |
|---|---|
| `constellate models` | **Running now**: each server, its models (as `--model` takes them) and, for exo, how many computers and how much memory together. Says when `contribute` will use a pool. Without one, a line pointing at exo for people with more than one computer. |
| `constellate contribute` | With no `--model`, a pool with a model ready comes first: it takes the steps that need a big model. A suggested model already running here takes the small steps and checks other computers' work, when it adds a size or a family. If none is running, it says what to pull. |
| Desktop app: **Lend this computer** | When no model is chosen in the app and a pool is ready, the card says so ("Ready: MODEL on exo pooling 2 computers…") and the switch starts `contribute --lend` with no model named, so the pool is used as above. Nothing to install or download first. |
| App: **Have your agent work on it**, **Plan it** | The pool's models come before other local models, with a note on how many computers they span. |
| `--model exo/MODEL`, `--model cluster/MODEL` | Name one directly. `exo/MODEL@PORT` for exo on another port. |

## Honest about what isn't done

- **Lending limits are read on this computer.** Hours per night and the CPU cap pace the work, so the whole pool
  rests when this computer rests. "Plugged in", battery and heat are checked here only; the other computers
  follow exo's own settings.
- **Not yet run on real pooled hardware.** The gate uses stand-ins that answer the way exo does. A run on two or
  more Macs over Thunderbolt 5 is tracked in issue #33.
- **Apple has been reported to be working on pooling Macs over Thunderbolt.** Nothing public says whether it will
  have an app interface. If it serves an OpenAI-compatible URL, `CONSTELLATE_CLUSTER_URL` already works with it;
  a test against it, once it exists, is tracked in issue #34.
