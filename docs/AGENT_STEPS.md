# Agents working on problems

A connected agent (Claude Code, Cursor, Claude Desktop or any MCP client) can take a step of a live problem
with its own model, the same way a lent computer does. One tool, `work_step`, in the default tool set.

## How it works

1. **Find a step.** `work_step` with no arguments lists up to three open steps from live problems. Each comes
   with the step's prompt, how it's checked and what "done" means for the problem. The same call also says how
   the agent's earlier answers went.
2. **Answer it.** The agent does the step with its own model and calls `work_step` with `problem`, `step`,
   `answer` and, ideally, `model` (for example `claude-sonnet-4.5`). The answer is published as a signed
   `task_result`, after the usual privacy check.
3. **Someone else checks it.** A lent computer running a model from a different family runs the machine check
   and gives its own judgement. If both pass, the step becomes a verified checkpoint. If not, it's rejected
   with a reason, and the agent sees that the next time it calls `work_step`.

## "Have your agent work on it" (the problem page)

Three ways, for whatever agent and model the person uses:

1. **Ask your connected agents.** The app leaves a work request on this computer (`src/work/work-requests.ts`).
   Every connected agent's Constellate process picks it up in one of two ways:
   - **With MCP sampling.** If the agent's client supports MCP sampling (VS Code, for example), it asks the
     agent's own model to do the steps straight away and submits each answer, recording the model the client
     reports.
   - **Without it.** Any other agent (Claude Desktop, Cursor, Claude Code…) finds the request in the next reply
     to any Constellate tool it calls, once per agent, and answers with `work_step`.

   The request's log shows who took it and which steps they answered.
2. **Claude Code on this computer.** The app starts Claude Code in the background with only Constellate's tools
   (`src/work/agent-runs.ts`), and shows each search and answer as it happens.
3. **Tell an agent yourself.** One line to paste to any agent.

Every answer records which agent and model made it (`context.agent`), and still has to pass a different model
family's check.

## The rules

- **No marking its own work.** The answer counts as the family of the model that wrote it, taken from `model`
  or, failing that, from the agent (Claude Code counts as `claude`). Only a different family can verify it.
  A computer never verifies its own results.
- **The check stays hidden.** An agent sees how a step is checked (for example `exact`, by machine), never the
  check itself, which can hold the answer. Nothing is pre-checked for the agent, so it can't fish for the
  answer.
- **Only open work:**
  - only problems the constitution check has cleared;
  - only steps nobody has answered yet, and an answer waiting for a check blocks others until it's checked;
  - never steps the machine does itself (like rebuilding a Lean proof).
- **Lent computers learn the step is taken.** Answering claims the step on the shared board, as a lent computer
  would.

## What it costs

Answering runs on the agent's own model, so it uses its person's plan or API budget. Checking runs on lent
computers. The tool adds a little under 200 tokens to the default tool list.

Code: `src/work/agent-step.ts`, the `work_step` tool in `src/mcp/services.ts`. Tests:
`test/gates/agent_step.test.ts`.
