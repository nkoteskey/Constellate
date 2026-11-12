// Plan it with your agent: hand an idea to an agent, which researches it and reports a plan in the
// network's format (checkable steps plus what it found). Nothing goes live until the person publishes it.
import { $, $$, esc, api, copy, toast, sheet, closeSheet, realm, STATIC, ls, agentToolSwitches } from './ui.js';

const post = (p, body = {}) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const STATUS = { waiting: 'Waiting for your agent', running: 'Your agent is working on it', reported: 'Plan ready for you to review', failed: 'Didn’t work', published: 'Published', discarded: 'Discarded' };

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const since = (iso) => { const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; };
/** What actually happened, in order: proof the agent ran, and what it did. */
function activity(req) {
  const log = req.log ?? [];
  if (!log.length) return '';
  return `<div class="card" style="margin:10px 0"><div class="eyebrow">What’s happened</div><ol class="plan-log">${log.map((l) => `<li><span class="faint num">${clock(l.at)}</span> ${esc(l.text)}</li>`).join('')}</ol>
    ${req.status === 'published' ? '' : '<p class="faint" style="font-size:12.5px;margin:8px 0 0">“Being worked on” changes only after you publish the plan: it becomes a live problem, and votes give it computer time.</p>'}</div>`;
}

/** The idea card's planning button, saying what clicking it will do for where its plan stands. */
export function planButtonLabel(req) {
  switch (req?.status) {
    case 'waiting': case 'running': return 'See how it’s going';
    case 'reported': return 'Review the plan';
    case 'failed': return 'Try planning again';
    case 'published': return 'Open the live problem';
    default: return 'Plan it with your agent'; // none yet, or discarded
  }
}

/** One line for an idea's card on the Proposals page: where its plan stands. */
export function planChip(req) {
  if (!req || req.status === 'discarded') return '';
  const label = { waiting: req.agent ? `${req.agent} is planning it` : 'Plan waiting for your agent', running: `${req.via === 'claude_code' ? 'Claude Code' : req.agent ?? 'Your agent'} is planning it · ${since(req.at)}`, reported: 'Plan ready to review', failed: 'Planning didn’t finish', published: 'Plan published' }[req.status] ?? req.status;
  const tone = req.status === 'reported' || req.status === 'published' ? 'ok' : req.status === 'failed' ? 'stop' : 'warn';
  const last = req.log?.at(-1);
  return `<div class="plan-chip"><span class="chip sm ${tone}"><span class="dot"></span>${esc(label)}</span>${last ? `<span class="faint" style="font-size:12.5px">${esc(last.text.slice(0, 110))}</span>` : ''}</div>`;
}

export async function planSheet(idea, { onPublished } = {}) {
  if (STATIC) { toast('Planning with your agent needs the app on your computer, where your agents are.', 5200); return; }
  const d = await api(`/api/plans?idea=${idea.id}`).catch((e) => ({ error: e.message }));
  if (d.error) { toast(d.error, 6000); return; }
  const el = sheet(`<div class="spread"><div class="eyebrow">Plan it with your agent</div><button class="btn ghost sm" data-close>Close</button></div>
    <h2 style="margin:6px 0 4px">${esc(idea.title)}</h2>
    <p class="muted" style="font-size:13.5px;margin:0 0 12px">Your agent researches related work and known traps, then proposes steps a machine can check. You review what it found, then publish or discard. Nothing goes live without you.</p>
    <div id="plan-body"></div>`, { label: 'Plan it with your agent' });
  let timer = 0;
  const stop = () => clearInterval(timer);
  const draw = async (req) => {
    if (!document.body.contains(el)) return stop();
    const body = $('#plan-body', el);
    if (!req) {
      // Every way to plan it, as one list: Claude Code first, then any model this computer reaches, then agents the
      // person has to start themselves. The first that runs on its own is chosen; one Start button.
      const o = d.options;
      const choices = [
        ...(o.claude_code ? [{ id: 'claude_code', name: 'Claude Code', note: 'Runs on this computer with only Constellate’s search and report tools. Usually a few minutes, billed to your Claude API key (never a Claude plan).' }] : []),
        ...(o.models ?? []).map((m) => ({ id: `model:${m.spec}`, name: m.name, note: `${m.note[0].toUpperCase()}${m.note.slice(1)}. Writes the plan from what this computer knows.` })),
        ...(o.model && !(o.models ?? []).some((m) => m.where === 'app') ? [{ id: 'model', name: o.model, note: 'The model this app was started with.' }] : []),
        { id: 'any_agent', name: 'Claude Desktop, Cursor or another connected agent', note: 'You have to start it yourself: these apps can’t be started by another app. After Start, open it and say “check Constellate for planning requests”.' },
      ];
      let pick = ls.get('planChoice', '');
      if (!choices.some((c) => c.id === pick)) pick = choices[0].id;
      body.innerHTML = `<div class="card"><div class="stack" role="radiogroup" aria-label="Who plans it" style="gap:8px">
        ${choices.map((c) => `<label class="row" style="align-items:flex-start;gap:10px;cursor:pointer"><input type="radio" name="plan-who" value="${esc(c.id)}"${c.id === pick ? ' checked' : ''} style="margin-top:4px"><span><b>${esc(c.name)}</b><span class="muted" style="display:block;font-size:13px">${esc(c.note)}</span>${c.id === 'claude_code' ? '<span id="plan-tools"></span>' : ''}</span></label>`).join('')}
        </div><div class="row" style="margin-top:12px"><button class="btn primary" id="plan-go">Start</button></div></div>`;
      $$('input[name="plan-who"]', body).forEach((r) => (r.onchange = () => { pick = r.value; ls.set('planChoice', pick); }));
      void agentToolSwitches($('#plan-tools', body));
      const go = $('#plan-go', body);
      go.onclick = async () => {
        go.disabled = true;
        const payload = pick.startsWith('model:') ? { via: 'model', spec: pick.slice(6) } : { via: pick };
        try { const r = await post('/api/plans', { idea: idea.id, ...payload }); draw(r); watch(r.id); } catch (e) { go.disabled = false; toast(e.message, 6000); }
      };
      return;
    }
    const rep = req.report;
    body.innerHTML = `<div class="spread" style="margin-bottom:10px"><span class="chip ${req.status === 'reported' || req.status === 'published' ? 'ok' : ''}"><span class="dot"></span>${STATUS[req.status] ?? req.status}</span><span class="faint" style="font-size:12px">${req.agent ? `from ${esc(req.agent)}` : ''}</span></div>
      ${req.status === 'waiting' ? `<p class="muted" style="font-size:13.5px"><b>Start it yourself:</b> open Claude Desktop (or your connected agent) and say “check Constellate for planning requests”. It finds this request with its <code>plan_report</code> tool and reports back here.</p><div class="row"><button class="btn sm" id="plan-copy">Copy that for your agent</button></div>` : ''}
      ${req.status === 'running' ? `<p class="muted" style="font-size:13.5px">Researching related work and drafting checkable steps, for ${since(req.at)} so far. You can close this: the idea’s card on the Proposals page shows how it’s going.</p>` : ''}
      ${activity(req)}
      ${req.status === 'failed' ? `<p class="muted" style="font-size:13.5px">${esc(req.error ?? 'It didn’t finish.')}</p>` : ''}
      ${rep ? `
        <div class="card" style="margin-bottom:10px"><div class="eyebrow">What it found</div>
          ${rep.findings.related.length ? `<div style="font-size:13.5px;margin-top:6px"><b>Related work</b><ul style="margin:4px 0 0;padding-left:18px">${rep.findings.related.map((r) => `<li>${esc(r.title)}<span class="faint">: ${esc(r.why)}</span></li>`).join('')}</ul></div>` : ''}
          ${rep.findings.risks.length ? `<div style="font-size:13.5px;margin-top:8px"><b>Risks</b><ul style="margin:4px 0 0;padding-left:18px">${rep.findings.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}
          ${rep.findings.open_questions.length ? `<div style="font-size:13.5px;margin-top:8px"><b>Open questions</b><ul style="margin:4px 0 0;padding-left:18px">${rep.findings.open_questions.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}
          <div style="font-size:13.5px;margin-top:8px"><b>Why a machine can check it</b><div class="muted">${esc(rep.findings.why_checkable)}</div></div>
          ${rep.findings.decision ? `<div style="font-size:13.5px;margin-top:8px"><b>What the result would change</b><div class="muted">${esc(rep.findings.decision)}</div></div>` : ''}
          ${rep.findings.alternatives?.length ? `<div style="font-size:13.5px;margin-top:8px"><b>Alternatives</b><ul style="margin:4px 0 0;padding-left:18px">${rep.findings.alternatives.map((a) => `<li>${esc(a.explanation)}<span class="faint">: weakened if ${esc(a.weakened_by)}</span></li>`).join('')}</ul></div>` : ''}
          ${rep.findings.would_show_wrong ? `<div style="font-size:13.5px;margin-top:8px"><b>What would show the plan is wrong</b><div class="muted">${esc(rep.findings.would_show_wrong)}</div></div>` : ''}
          ${rep.findings.stop_rule ? `<div style="font-size:13.5px;margin-top:8px"><b>When to stop</b><div class="muted">${esc(rep.findings.stop_rule)}</div></div>` : ''}
        </div>
        <div class="card"><div class="eyebrow">The plan</div>
          <div class="serif" style="font-size:19px;margin-top:6px">${esc(rep.plan.title)}</div>
          ${rep.plan.hook ? `<div class="muted" style="font-size:13.5px">${esc(rep.plan.hook)}</div>` : ''}
          <div class="faint" style="font-size:12.5px;margin-top:6px">${esc(realm(rep.plan.realm).short)} · checked with <code>${esc(rep.plan.verifier)}</code> · ${rep.plan.steps.length} step${rep.plan.steps.length === 1 ? '' : 's'}</div>
          <div style="font-size:13.5px;margin-top:8px"><b>Done means</b> <span class="muted">${esc(rep.plan.done_description)}</span></div>
          <ol style="margin:10px 0 0;padding-left:20px;display:grid;gap:6px;font-size:13.5px">${rep.plan.steps.map((s) => `<li><b>${esc(s.title)}</b><div class="faint" style="font-size:12.5px">check: <code>${esc(JSON.stringify(s.check)).slice(0, 160)}</code>${s.after?.length ? ` · after ${s.after.map(esc).join(', ')}` : ''}</div></li>`).join('')}</ol>
        </div>
        ${req.problems?.length ? `<div class="card" style="margin-top:10px;border-color:rgba(255,120,120,.35)"><b>Needs fixing before it can go live</b><ul style="margin:4px 0 0;padding-left:18px;font-size:13.5px">${req.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><p class="faint" style="font-size:12.5px;margin:6px 0 0">Ask your agent to report again; the request stays open.</p></div>` : ''}` : ''}
      <div class="row" style="margin-top:12px">
        ${req.status === 'reported' && !req.problems?.length ? '<button class="btn primary" id="plan-publish">Publish as a problem</button>' : ''}
        ${['waiting', 'running', 'reported', 'failed'].includes(req.status) ? '<button class="btn ghost sm" id="plan-discard">Discard</button>' : ''}
        ${req.status === 'failed' || req.status === 'discarded' ? '<button class="btn sm" id="plan-again">Try again</button>' : ''}
      </div>`;
    const c = $('#plan-copy', body); if (c) c.onclick = () => copy('Check Constellate for planning requests and report a plan for each.', 'Copied. Paste it to your agent');
    const pub = $('#plan-publish', body); if (pub) pub.onclick = async () => { pub.disabled = true; try { const r = await post(`/api/plans/${req.id}/publish`); stop(); closeSheet(); toast('Published. It’s a live problem now.'); onPublished?.(r.problem); } catch (e) { pub.disabled = false; toast(e.message, 6000); } };
    const dis = $('#plan-discard', body); if (dis) dis.onclick = async () => { await post(`/api/plans/${req.id}/discard`).catch(() => {}); stop(); draw(null); };
    const again = $('#plan-again', body); if (again) again.onclick = () => { stop(); draw(null); };
  };
  const watch = (id) => { stop(); timer = setInterval(async () => { const r = await api(`/api/plans/${id}`).catch(() => null); if (!r || !document.body.contains(el)) return stop(); draw(r); if (!['waiting', 'running'].includes(r.status)) stop(); }, 3000); };
  // An attempt still going or waiting for review; otherwise, if the latest one failed, that one, so the person
  // sees why (its log) before trying again.
  const open = d.requests.find((r) => ['waiting', 'running', 'reported'].includes(r.status)) ?? (d.requests[0]?.status === 'failed' ? d.requests[0] : undefined);
  draw(open ?? null);
  if (open && open.status !== 'reported') watch(open.id);
  // Nothing to choose: start with what this computer can run on its own (Claude Code, else the app's model). Only
  // with neither does it list the ways in, including leaving it for a connected agent.

}
