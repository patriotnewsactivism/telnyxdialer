// Telnyx AI Dialer — frontend SPA (installable PWA)
const API = location.origin;
let state = {
  configured: false,
  calls: [],
  campaigns: [],
  campaign: null,
  leads: [],
  results: [],
  activeTab: 'dashboard',
  settings: {
    defaultVoice: 'Brian',
    fromNumber: '',
    takeoverNumber: '',
    baseUrl: '',
  },
  liveCall: null,
};
let deferredInstallPrompt = null;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

async function api(path, { method = 'GET', body, headers: extra } = {}) {
  const opts = { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { data = { _raw: text }; }
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  return data;
}

function el(html) {
  const t = document.createElement('template'); t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function toast(msg, kind = 'ok') {
  const b = el(`<div class="fixed bottom-24 left-4 right-4 z-50 ${kind === 'err' ? 'bg-red-900/90 border border-red-500/50' : 'bg-emerald-900/90 border border-emerald-500/50'} text-white px-4 py-3 rounded-xl border text-sm shadow-xl">${escapeHtml(msg)}</div>`);
  document.body.appendChild(b);
  setTimeout(() => b.remove(), 3000);
}

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmt(iso) { if (!iso) return '—'; return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function dispositionClass(d) {
  const m = { answered: 'b-answered', voicemail: 'b-voicemail', failed: 'b-failed', takeover: 'b-takeover', no_answer: 'b-no_answer', dnc: 'b-no_answer', skipped: 'b-no_answer' };
  return m[d ?? ''] || 'bg-slate-700 text-slate-300';
}

/* ---------- shell ---------- */
async function load() {
  try {
    const h = await api('/api/health');
    state.configured = h.telnyx_configured;
    state.settings.baseUrl = h.base_url;
  } catch (e) {
    state.configured = false;
  }
  await Promise.all([loadCalls(), loadCampaigns()]);
  render();
}
async function loadCalls() { state.calls = (await api('/api/calls')).calls || []; }
async function loadCampaigns() { state.campaigns = (await api('/api/campaigns')).campaigns || []; }

function showTab(id) {
  state.activeTab = id;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === id));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === id));
  if (id === 'campaigns') renderCampaigns();
  if (id === 'results') renderResults();
  if (id === 'notetaker') renderNotetaker();
  if (id === 'dialer') renderDialer();
}

/* ---------- dashboard ---------- */
function renderDashboard() {
  const total = state.campaigns.reduce((a, c) => a + c.stats.total, 0);
  const answered = state.campaigns.reduce((a, c) => a + (c.stats.answered || 0), 0);
  const panel = $('#dashboard');
  panel.innerHTML = `
    <div class="card"><h3>System</h3>
      <div class="row"><div class="col"><div class="small">Telnyx API</div><div class="bold">${state.configured ? 'configured' : 'NOT CONFIGURED — copy .env.example to .env and set TELNYX_API_KEY'}</div></div>
      <div class="col"><div class="small">Webhook for Telnyx console</div><div class="small break">${state.settings.baseUrl}/api/webhooks/telnyx</div></div></div>
    </div>
    <div class="grid">
      <div class="card"><h3>Quick dial</h3><p class="small">Start a single outbound call with AI voice + optional recording, SMS follow-up and voicemail drop.</p>
        <div class="row"><a href="#dialer" class="btn btn-primary" onclick="showTab('dialer')">Open dialer</a></div>
      </div>
      <div class="card"><h3>Campaigns</h3><p class="small">Progressive (one-at-a-time) dialing through a lead list with skip trace, dispositions and notetaker summaries.</p>
        <div class="row"><a href="#campaigns" class="btn btn-primary" onclick="showTab('campaigns')">Manage campaigns</a></div>
      </div>
    </div>
    <div class="card"><h3>Totals</h3><div class="row"><div class="col"><div class="small">Campaigns</div><div class="bold">${state.campaigns.length}</div></div><div class="col"><div class="small">Leads</div><div class="bold">${total}</div></div><div class="col"><div class="small">Answered</div><div class="bold">${answered}</div></div></div></div>
  `;
}

/* ---------- dialer ---------- */
function renderDialer() {
  const panel = $('#dialer');
  panel.innerHTML = `
    <div class="card"><h3>Manual dial</h3>
      <div class="row">
        <div class="col"><label>Number</label><input id="dialTo" type="tel" placeholder="+15550001234"></div>
        <div class="col"><label>From (caller ID)</label><input id="dialFrom" type="tel" placeholder="+18329757665" value="${escapeHtml(state.settings.fromNumber)}"></div>
      </div>
      <div class="row">
        <div class="col"><label>Voice provider</label><select id="dialProvider"><option>telnyx</option><option>elevenlabs</option><option>cartesia</option><option>openai</option></select></div>
        <div class="col"><label>Voice name</label><input id="dialVoice" value="${escapeHtml(state.settings.defaultVoice)}"></div>
      </div>
      <div class="row"><div class="col"><label>Language</label><input id="dialLang" value="en-US"></div></div>
      <div class="row"><div class="col"><label>Script (supports {{name}})</label><textarea id="dialScript">Hi {{name}}, this is your AI assistant calling. How can I help you today?</textarea></div></div>
      <div class="row">
        <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="dialAmd" checked> Answering machine detection</label>
        <div class="small" style="margin-left:6px">Detects voicemail/IVR on answer</div>
      </div>
      <div class="row"><div class="col"><label>SMS after call</label><input id="dialSms" type="tel" placeholder="+15550000000 (optional follow-up number)"></div></div>
      <div class="row"><button id="btnDial" class="btn btn-primary" style="width:100%">Place call</button></div>
    </div>
    <div class="card"><h3>Live call</h3><div id="liveCalls"></div></div>
  `;
  $('#btnDial').onclick = async () => {
    const to = $('#dialTo').value.trim();
    if (!to) return toast('Enter a number', 'err');
    try {
      const call = await api('/api/calls/dial', {
        method: 'POST',
        body: {
          to, from: $('#dialFrom').value || undefined,
          voice: $('#dialVoice').value || undefined,
          language: $('#dialLang').value || 'en-US',
          script: $('#dialScript').value || undefined,
          answering_machine_detection: $('#dialAmd').checked,
          sms_after_call: $('#dialSms').value || undefined,
        },
      });
      state.liveCall = call.call;
      putLiveCall(call.call);
      loadCalls();
      toast('Call placed');
    } catch (e) { toast(e.message, 'err'); }
  };
  renderLiveCalls();
}

function putLiveCall(call) {
  state.liveCall = call;
  const box = $('#liveCalls');
  if (!call) { box.innerHTML = '<p class="small">No live call</p>'; return; }
  box.innerHTML = `
    <div class="chip"><div><div class="n">${escapeHtml(call.number)}</div><div class="d">${call.status} · ${fmt(call.started_at)}</div></div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-outline btn-sm" onclick="appSpeak()">Speak</button>
        <button class="btn btn-outline btn-sm" onclick="appRecord()">Record</button>
        <button class="btn btn-outline btn-sm" onclick="appVm()">Voicemail drop</button>
        <button class="btn btn-outline btn-sm" onclick="appTransfer()">Takeover</button>
        <button class="btn btn-danger btn-sm" onclick="appHangup()">Hang up</button>
      </div></div>
    <div style="margin-top:8px"><label>Say:</label> <input id="sayText" type="text" placeholder="Say something…" style="width:70%"> <button class="btn btn-sm btn-primary" onclick="sayNow()">Go</button></div>
  `;
}
function renderLiveCalls() {
  const box = $('#liveCalls');
  const call = state.liveCall || state.calls.find((c) => c.status === 'answered' || c.status === 'ringing');
  if (!call) { box.innerHTML = '<p class="small">No live call</p>'; return; }
  putLiveCall(call);
}
window.appSpeak = async () => {
  if (!state.liveCall) return toast('No live call', 'err');
  const text = prompt('What should the agent say?');
  if (!text) return;
  await api(`/api/calls/${state.liveCall.call_control_id}/speak`, { method: 'POST', body: { text } });
  toast('Spoke');
};
window.appRecord = async () => {
  const start = confirm('Start recording this call?');
  const r = await api(`/api/calls/${state.liveCall.call_control_id}/record_${start ? 'start' : 'stop'}`, { method: 'POST' });
  toast(start ? 'Recording started' : 'Recording stopped');
};
window.appVm = async () => {
  const script = prompt('Voicemail message:', 'Hi, this is an automated call. Please call us back at your convenience.');
  if (!script) return;
  await api(`/api/calls/${state.liveCall.call_control_id}/voicemail`, { method: 'POST', body: { script } });
  toast('Voicemail dropped');
};
window.appTransfer = async () => {
  const to = prompt('Transfer to (agent number):');
  if (!to) return;
  await api(`/api/calls/${state.liveCall.call_control_id}/transfer`, { method: 'POST', body: { to } });
  toast('Transferring…');
};
window.appHangup = async () => {
  await api(`/api/calls/${state.liveCall.call_control_id}/hangup`, { method: 'POST' });
  state.liveCall = null;
  renderDialer();
};
window.sayNow = async () => {
  const t = $('#sayText').value.trim();
  if (!t || !state.liveCall) return;
  await api(`/api/calls/${state.liveCall.call_control_id}/speak`, { method: 'POST', body: { text: t } });
  $('#sayText').value = '';
  toast('Spoke');
};

/* ---------- campaigns ---------- */
function renderCampaigns() {
  const panel = $('#campaigns');
  const list = state.campaigns.map((c) => `
    <div class="card" style="margin-bottom:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
        <div>
          <div style="font-weight:700">${escapeHtml(c.name)}</div>
          <div class="small">Status: ${c.status} · total ${c.stats.total} · answered ${c.stats.answered || 0} · VM ${c.stats.voicemail || 0} · takeover ${c.stats.takeover || 0} · failed ${c.stats.failed || 0}</div>
        </div>
        <div style="display:flex;gap:4px">
          ${c.status === 'active'
            ? `<button class="btn btn-sm btn-outline" onclick="toggleCampaign('${c.id}','pause')">Pause</button><button class="btn btn-sm btn-outline" onclick="toggleCampaign('${c.id}','stop')">Stop</button>`
            : c.status === 'completed'
            ? `<button class="btn btn-sm btn-primary" onclick="toggleCampaign('${c.id}','resume')">Resume</button>`
            : `<button class="btn btn-sm btn-primary" onclick="toggleCampaign('${c.id}','start')">Start progressive dial</button>`}
          <button class="btn btn-sm btn-outline" onclick="viewCampaign('${c.id}')">Leads</button>
          <button class="btn btn-sm btn-danger" onclick="delCampaign('${c.id}')" style="color:#f87171">Del</button>
        </div>
      </div>
    </div>
  `).join('') || '<p class="small">No campaigns yet.</p>';
  panel.innerHTML = `
    <div class="card"><h3>New campaign</h3>
      <div class="row"><div class="col"><label>Name</label><input id="campName" placeholder="Spring leads"></div></div>
      <div class="row"><div class="col"><label>Script ({{name}} merges lead fields)</label><textarea id="campScript" rows="3">Hi {{name}}, this is an automated call from your campaign. Are you interested in hearing more?</textarea></div></div>
      <div class="row"><div class="col"><label>Voice</label><input id="campVoice" value="Brian"></div><div class="col"><label>From number</label><input id="campFrom" placeholder="+18329757665"></div></div>
      <div class="row"><label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="campAmd" checked> Answering machine detection</label></div>
      <div class="row"><button id="btnNewCamp" class="btn btn-primary" style="width:100%">Create campaign</button></div>
    </div>
    <div class="card"><h3>Campaigns</h3>${list}</div>
  `;
  $('#btnNewCamp').onclick = async () => {
    try {
      await api('/api/campaigns', { method: 'POST', body: {
        name: $('#campName').value || 'Untitled',
        script: $('#campScript').value,
        voice: $('#campVoice').value || 'Brian',
        from: $('#campFrom').value || undefined,
        answering_machine_detection: $('#campAmd').checked,
      }});
      await loadCampaigns();
      renderDashboard();
      renderCampaigns();
      toast('Campaign created');
    } catch (e) { toast(e.message, 'err'); }
  };
}

window.toggleCampaign = async (id, action) => {
  try {
    await api(`/api/campaigns/${id}/${action}`, { method: 'POST' });
    await loadCampaigns();
    renderCampaigns();
    renderDashboard();
  } catch (e) { toast(e.message, 'err'); }
};
window.delCampaign = async (id) => {
  if (!confirm('Delete campaign?')) return;
  await api(`/api/campaigns/${id}`, { method: 'DELETE' });
  await loadCampaigns();
  renderCampaigns();
  renderDashboard();
};
window.viewCampaign = async (id) => {
  showTab('leads');
  await loadCampaignLeads(id);
};

async function loadCampaignLeads(id) {
  const c = state.campaigns.find((x) => x.id === id);
  state.campaign = c;
  state.leads = await api(`/api/campaigns/${id}/leads`).then((r) => r.leads || []);
  state.results = await api(`/api/campaigns/${id}/results`).then((r) => r.results || []);
  renderLeads();
}

function renderLeads() {
  const c = state.campaign;
  if (!c) return;
  const panel = $('#leads');
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px">
      <div><div class="bold">${escapeHtml(c.name)}</div><div class="small">Leads · ${state.leads.length} total · ${state.results.length} dialed</div></div>
      <div style="display:flex;gap:4px">
        <button class="btn btn-sm btn-outline" onclick="showTab('campaigns')">Back</button>
        <input id="leadFile" type="file" accept=".csv" style="display:none">
        <button class="btn btn-sm btn-outline" onclick="$('#leadFile').click()">Import CSV</button>
        <button class="btn btn-sm btn-primary" onclick="addLead()">Add lead</button>
      </div>
    </div>
    <div class="card"><h3>Leads</h3>
      <div id="leadsList">${state.leads.map((l) => `
        <div class="chip">
          <div><div class="n">${escapeHtml(l.name || '—')} ${escapeHtml(l.number || '')}</div>
            <div class="d">${fmt(l.created_at)} ${l.dnc ? '· DNC' : ''} ${l.skip_trace ? '· skip-traced' : ''}</div></div>
          <div class="badge ${dispositionClass(resultBadge(l))}">${resultBadge(l) || '—'}</div>
        </div>
      `).join('') || '<p class="small">No leads.</p>'}</div>
    </div>
  `;
  $('#leadFile').onchange = async (e) => {
    const fd = new FormData(); fd.append('file', e.target.files[0]);
    const res = await fetch(`${API}/api/campaigns/${c.id}/leads`, { method: 'POST', body: fd });
    if (!res.ok) { toast(await res.text(), 'err'); return; }
    await loadCampaignLeads(c.id);
    toast('Leads imported');
  };
}
function resultBadge(l) {
  const r = state.results.find((x) => x.lead_id === l.id);
  return r ? r.disposition : null;
}

window.addLead = async () => {
  const name = prompt('Lead name:');
  if (!name) return;
  const number = prompt('Phone number:');
  if (!number) return;
  await api(`/api/campaigns/${state.campaign.id}/leads`, { method: 'POST', body: { name, number } });
  await loadCampaignLeads(state.campaign.id);
  toast('Lead added');
};

/* ---------- results ---------- */
function renderResults() {
  const panel = $('#results');
  const rows = state.results.map((r) => `
    <div class="chip" style="margin-bottom:6px">
      <div>
        <div class="n">${escapeHtml((r.lead && r.lead.name) || '—')} · ${escapeHtml(r.number || '—')}</div>
        <div class="d">${r.disposition} · ${fmt(r.started_at)} · ${r.duration_ms ? (r.duration_ms/1000).toFixed(0) + 's' : '—'}</div>
      </div>
      <div class="badge ${dispositionClass(r.disposition)}">${r.disposition}</div>
    </div>
  `).join('') || '<p class="small">No results yet.</p>';
  panel.innerHTML = `<div class="card"><h3>Call results</h3>${rows}</div>`;
}

/* ---------- notetaker ---------- */
function renderNotetaker() {
  const panel = $('#notetaker');
  panel.innerHTML = `
    <div class="card"><h3>AI notetaker</h3>
      <p class="small">Transcribe a Telnyx recording with faster-whisper (local, private), LLM-summarize, and email the notes.</p>
      <div class="row"><div class="col"><label>Recording URL or recording ID</label><input id="ntRec" placeholder="https://api.telnyx.com/v2/recordings/... or rec_abc"></div></div>
      <div class="row"><div class="col"><label>Call ID (to save notes under)</label><input id="ntCallId" placeholder="call_control_id (optional)"></div></div>
      <div class="row"><button id="btnTranscribe" class="btn btn-primary" style="width:100%">Transcribe + summarize</button></div>
    </div>
    <div id="noteOut" class="card"></div>
  `;
  $('#btnTranscribe').onclick = async () => {
    const rec = $('#ntRec').value.trim();
    const callId = $('#ntCallId').value.trim() || undefined;
    if (!rec) return toast('Enter a recording URL or ID', 'err');
    try {
      const { note } = await api('/api/notetaker/transcribe', { method: 'POST', body: { recording_url: rec.startsWith('http') ? rec : undefined, recording_id: rec.startsWith('http') ? undefined : rec, call_id: callId } });
      $('#noteOut').innerHTML = `
        <h3>Notes</h3>
        <div class="row"><div class="col"><label>Summary</label><textarea id="ntSummary" rows="6">${escapeHtml(note.summary || '')}</textarea></div></div>
        <div class="row"><div class="col"><label>Transcript</label><textarea id="ntTranscript" rows="8" readonly>${escapeHtml(note.text || '')}</textarea></div></div>
        <div class="row">
          <div class="col"><label>Email to</label><input id="ntEmail" type="email" placeholder="manager@example.com"></div>
          <div class="col"><label>Subject</label><input id="ntSubject" value="Call notes — ${note.recording_id}"></div>
          <button class="btn btn-primary" style="width:100%;margin-top:22px" onclick="emailNotes('${note.recording_id}')">Email notes</button>
        </div>
        <p class="small">Recording: ${escapeHtml(note.recording_url || '—')} · ${note.transcribed_at}</p>
      `;
      toast('Transcribed');
    } catch (e) { toast(e.message, 'err'); }
  };
}
window.emailNotes = async (recordingId) => {
  const to = $('#ntEmail').value.trim();
  const subject = $('#ntSubject').value.trim();
  const callId = $('#ntCallId').value.trim() || undefined;
  if (!to) return toast('Enter recipient email', 'err');
  try {
    const target = callId || recordingId;
    await api(`/api/notetaker/email/${target}`, { method: 'POST', body: { to, subject } });
    toast('Notes emailed');
  } catch (e) { toast(e.message, 'err'); }
};

/* ---------- settings ---------- */
function renderSettings() {
  const panel = $('#settings');
  panel.innerHTML = `
    <div class="card"><h3>Settings</h3>
      <div class="row"><div class="col"><label>Default voice</label><input id="stVoice" value="${escapeHtml(state.settings.defaultVoice)}"></div></div>
      <div class="row"><div class="col"><label>Default from number</label><input id="stFrom" value="${escapeHtml(state.settings.fromNumber)}"></div></div>
      <div class="row"><div class="col"><label>Takeover number (agent)</label><input id="stTakeover" value="${escapeHtml(state.settings.takeoverNumber)}"></div></div>
      <div class="row"><button id="btnSaveSt" class="btn btn-primary" style="width:100%">Save</button></div>
    </div>
    <div class="card"><h3>Feature map</h3>
      <ul style="line-height:1.8;color:#cbd5e1">
        <li><b>Outbound AI dial:</b> POST /api/calls/dial — Telnyx Call Control, custom voice/script per call.</li>
        <li><b>Takeover:</b> POST /api/calls/:id/transfer — patch a live agent into an active call.</li>
        <li><b>AI notetaker:</b> POST /api/notetaker/transcribe — faster-whisper transcription + LLM summary, POST /api/notetaker/email/:id delivery.</li>
        <li><b>SMS:</b> POST /api/sms/send — automatic post-call follow-up text.</li>
        <li><b>Email:</b> notetaker notes delivered over SMTP.</li>
        <li><b>1-click voicemail:</b> POST /api/calls/:id/voicemail — speak a VM script, then hang up.</li>
        <li><b>Voicemail detection:</b> Telnyx answering-machine detection + server-side short-call heuristic.</li>
        <li><b>Skip trace:</b> GET /api/lookup/:number — Telnyx number lookup (carrier, line type, validity).</li>
        <li><b>Campaign mode:</b> progressive one-at-a-time dialer over CSV lead lists with dispositions and retry state.</li>
        <li><b>PWA:</b> manifest.json + service worker — "Add to home screen" works on iOS/Android.</li>
      </ul>
    </div>
  `;
  $('#btnSaveSt').onclick = () => {
    state.settings.defaultVoice = $('#stVoice').value;
    state.settings.fromNumber = $('#stFrom').value;
    state.settings.takeoverNumber = $('#stTakeover').value;
    renderDialer();
    toast('Settings saved (session)');
  };
}

/* ---------- PWA install ---------- */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  $('#installBanner').classList.add('show');
});
$('#btnInstall').onclick = async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $('#installBanner').classList.remove('show');
  toast(outcome === 'accepted' ? 'Installed' : 'Install declined');
};

/* ---------- boot ---------- */
function render() {
  const shell = `
    <div class="header">
      <div style="display:flex;align-items:center;gap:10px"><span style="font-weight:700">☎ Telnyx AI Dialer</span> <span id="cfgBadge" class="status ${state.configured ? '' : 'warn'}">${state.configured ? 'Telnyx connected' : 'Telnyx not configured'}</span></div>
      <div style="display:flex;gap:6px"><button class="btn btn-sm btn-ghost" onclick="showTab('settings')">Settings</button></div>
    </div>
    <div id="installBanner" class="install-banner">
      <span class="small">Install this app on your phone?</span>
      <button class="btn btn-primary btn-sm" id="btnInstall">Add to home screen</button>
      <button class="btn btn-sm btn-ghost" onclick="$('#installBanner').classList.remove('show')">✕</button>
    </div>
    <div class="tabs">
      <div class="tab" data-tab="dashboard" onclick="showTab('dashboard')">Dashboard</div>
      <div class="tab" data-tab="dialer" onclick="showTab('dialer')">Dialer</div>
      <div class="tab" data-tab="campaigns" onclick="showTab('campaigns')">Campaigns</div>
      <div class="tab" data-tab="leads" onclick="showTab('leads')">Leads</div>
      <div class="tab" data-tab="results" onclick="showTab('results')">Results</div>
      <div class="tab" data-tab="notetaker" onclick="showTab('notetaker')">Notetaker</div>
    </div>
    <div class="panel active" id="dashboard"></div>
    <div class="panel" id="dialer"></div>
    <div class="panel" id="campaigns"></div>
    <div class="panel" id="leads"></div>
    <div class="panel" id="results"></div>
    <div class="panel" id="notetaker"></div>
    <div class="panel" id="settings"></div>
    <div id="liveBar" class="live-bar"><div class="num" id="liveBarNum">—</div> <div class="small" id="liveBarStat">idle</div></div>
    <footer>Telnyx AI Dialer · PWA · calls/SMS via Telnyx API · notetaker via faster-whisper + LLM</footer>
  `;
  document.body.innerHTML = shell;
  $('#cfgBadge').textContent = state.configured ? 'Telnyx configured' : 'Telnyx not configured — set TELNYX_API_KEY';
  renderDashboard();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(() => console.log('SW registered')).catch((e) => console.error('SW', e));
  }
}

window.showTab = showTab;
load();
