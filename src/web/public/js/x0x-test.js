// The x0x home test (src/x0x/home-test.ts, docs/X0X_HOME_TEST.md): run a session, see the exact numbers, then
// choose to send them. Nothing is sent without that press.
import { esc, api, toast } from './ui.js';

const LABELS = {
  peers_median: 'Peers (median)', degraded_share_median: 'Share of links one-sided', direct_share_median: 'Share of peers reached directly',
  hole_punch_success_rate: 'Hole-punch success rate', avg_rtt_ms_median: 'Round trip to peers (ms)', reconnections_per_hour: 'Reconnections per hour',
  delivered_per_published: 'Delivered per published', duplicates_dropped_per_minute: 'Duplicates dropped per minute', verify_ms_per_minute: 'Signature checks (ms per minute)',
  idle_up_bps_median: 'Idle upload (bytes/s)', idle_down_bps_median: 'Idle download (bytes/s)', active_up_bps_median: 'Upload while testing (bytes/s)',
  echo_rtt_ms_median: 'Test message round trip (ms)', echoes_per_probe: 'Computers answering each test message', cohort_seen: 'Other test sessions heard',
};

export async function x0xTestCard(slot) {
  if (!slot) return;
  const st = await api('/api/x0x-test').catch(() => null);
  if (!st) { slot.innerHTML = ''; return; }
  const results = await api('/api/x0x-test/results').catch(() => null);
  const rows = (m) => Object.entries(m).map(([k, v]) => `<tr><td class="muted">${esc(LABELS[k] ?? k.replace(/_/g, ' '))}</td><td class="num" style="text-align:right">${esc(String(v))}</td></tr>`).join('');
  slot.innerHTML = `<div class="card" id="x0x-test"><div class="eyebrow">Help test x0x</div>
    <p class="muted" style="margin:6px 0 0;font-size:13.5px">A 15-minute test of how the x0x network behaves on your connection: peers, direct connections, how fast messages travel, and bandwidth. You see every number before anything is sent, and only numbers are sent: never your address or IDs.</p>
    ${results?.computers ? `<p class="faint" style="font-size:12.5px;margin:6px 0 0">${results.computers} computer${results.computers === 1 ? '' : 's'} have taken part so far.</p>` : ''}
    ${!st.x0x ? '<p class="faint" style="font-size:13px;margin:10px 0 0">x0x isn’t running on this computer yet. Join the network first (Connect).</p>'
      : st.running ? `<p style="margin:10px 0 0">Measuring: ${esc(st.phase === 'active' ? 'sending small test messages' : 'listening quietly')} · ${Math.round(st.done * 100)}%</p>`
      : st.report ? `<table style="width:100%;font-size:13px;margin-top:10px"><tr><td class="muted">NAT type</td><td style="text-align:right">${esc(st.report.nat_type)}</td></tr>${rows(st.report.metrics)}</table>
          ${st.sent ? '<p class="faint" style="font-size:12.5px">Sent. Thank you.</p>' : '<div class="row" style="margin-top:10px;gap:8px"><button class="btn primary" id="xt-send">Send these numbers</button><button class="btn ghost" id="xt-start">Run again</button></div>'}`
      : `${st.error ? `<p class="faint" style="font-size:12.5px">Last run stopped: ${esc(st.error)}</p>` : ''}<button class="btn primary" id="xt-start" style="margin-top:10px">Start the 15-minute test</button>`}
  </div>`;
  const start = slot.querySelector('#xt-start'), send = slot.querySelector('#xt-send');
  if (start) start.onclick = async () => { await api('/api/x0x-test/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minutes: 15 }) }).catch((e) => toast(`Couldn’t start: ${e.message}`)); x0xTestCard(slot); };
  if (send) send.onclick = async () => { await api('/api/x0x-test/send', { method: 'POST' }).catch((e) => toast(`Not sent: ${e.message}`)); toast('Sent. Thank you.'); x0xTestCard(slot); };
  if (st.running) setTimeout(() => { if (document.body.contains(slot)) x0xTestCard(slot); }, 5000);
}
