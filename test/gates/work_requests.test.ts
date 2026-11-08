import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { RecordStore } from '../../src/store/records.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { ProblemBody } from '../../src/work/problems.js';

/**
 * "Have your agent work on it", for whatever agent is connected: the app leaves a work request; an agent whose
 * client supports MCP sampling does the steps with its own model straight away; any other agent gets the
 * request with its next Constellate reply and answers with work_step. The request's log says who did what.
 */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const problemBody = () => ProblemBody.parse({ title: 'Small facts', hook: 'Tiny', goal: 'Answer small questions exactly, checked by machine.', realm: 'maths_physics', definition_of_done: { verifier: 'exact', description: 'Matches exactly.' },
  chunks: [{ key: 'first', title: 'Six times seven', prompt: 'What is 6 × 7?', check: { expected: '42' }, needs: { size: 'any' } }, { key: 'second', title: 'Two to the tenth', prompt: 'What is 2^10?', check: { expected: '1024' }, needs: { size: 'any' } }] });

describe('your connected agents work on a problem, whichever they are', () => {
  it('an agent whose client supports sampling does the steps with its own model, straight away', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'wr-'));
    try {
      const hub = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
      const id = (await hub.collective.propose(problemBody())).problem!.id;
      const req = hub.workRequests.create(id, 'Small facts', 2);

      const server = createMcpServer(hub);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'Visual Studio Code', version: '1' }, { capabilities: { sampling: {} } });
      const asked: string[] = [];
      client.setRequestHandler(CreateMessageRequestSchema, async (r) => {
        const text = (r.params.messages[0].content as { text: string }).text; asked.push(text);
        return { role: 'assistant', model: 'gpt-5', content: { type: 'text', text: text.includes('6 × 7') ? '42' : '1024' } };
      });
      await Promise.all([server.connect(a), client.connect(b)]);
      for (let i = 0; i < 100 && hub.workRequests.get(req.id)!.status !== 'done'; i++) await wait(30);

      const r = hub.workRequests.get(req.id)!;
      expect(r).toMatchObject({ status: 'done', steps: 2, by: 'VS Code' });
      expect(asked[0]).toMatch(/Six times seven/);
      expect(asked.join(' ')).not.toMatch(/"42"|expected/); // the check (it holds the answer) is never sent
      const results = hub.node.store.ofKind('task_result').map((s) => s.rec);
      expect(results.map((x) => (x.body as { output: string }).output).sort()).toEqual(['1024', '42']);
      expect(results[0].context.agent).toMatchObject({ client: 'VS Code', model: 'gpt-5' });
      expect((results[0].body as { family: string }).family).toBe('openai'); // so a non-OpenAI model checks it
      expect(r.log.map((l) => l.text)).toEqual(expect.arrayContaining(['VS Code took this, using its own model.', 'VS Code (gpt-5) answered step “first”; it waits for a different model family to check it.']));
      await client.close();
    } finally { delete process.env.CONSTELLATE_HOME; }
  });

  it('any other agent gets the request with its next Constellate reply, and its work_step answers count toward it', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'wr-'));
    try {
      const hub = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
      const id = (await hub.collective.propose(problemBody())).problem!.id;
      const req = hub.workRequests.create(id, 'Small facts', 1);

      const server = createMcpServer(hub);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'claude-ai', version: '1' }); // Claude Desktop: no sampling
      await Promise.all([server.connect(a), client.connect(b)]);
      const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);

      const first = await call('failures_search', { query: 'anything' });
      expect(first.person_asked).toMatch(new RegExp(`work_step with problem "${id}"`));
      expect((await call('failures_search', { query: 'again' })).person_asked).toBeUndefined(); // once per agent
      expect(hub.workRequests.get(req.id)!.log.at(-1)!.text).toMatch(/Passed to Claude Desktop/);

      await call('work_step', { problem: id, step: 'first', answer: '42', model: 'claude-opus-4' });
      expect(hub.workRequests.get(req.id)).toMatchObject({ status: 'done', steps: 1, by: 'Claude Desktop' });
      await client.close();
    } finally { delete process.env.CONSTELLATE_HOME; }
  });
});
