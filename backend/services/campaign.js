'use strict';

/*
 * Campaign engine — progressive (one-at-a-time) outbound dialer.
 * State lives in memory; wiring: Telnyx webhooks feed call results back into the engine
 * (see routes/webhooks.js), so the engine never needs to poll Telnyx for call state.
 *
 * Campaign lifecycle: draft -> active -> paused | completed
 * Dispositions: answered | no_answer | busy | failed | voicemail | takeover | dnc | skipped
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

class CampaignEngine extends EventEmitter {
  constructor({ telnyx, notetaker, baseUrl } = {}) {
    super();
    this.telnyx = telnyx;
    this.notetaker = notetaker;
    this.baseUrl = baseUrl || process.env.BASE_URL || 'http://localhost:3000';
    this.campaigns = new Map();   // id -> campaign
    this.leads = new Map();       // campaignId -> Map(leadId -> lead)
    this.results = new Map();     // campaignId -> Map(leadId -> result)
    this.active = null;           // currently running campaign id
    this.dialing = false;         // progressive dial loop lock
    this.defaults = {
      voice: process.env.TELNYX_TTS_VOICE || 'Brian',
      language: process.env.TELNYX_TTS_LANGUAGE || 'en-US',
      timeout_secs: 30,
      answering_machine_detection: true,
      ring_delay_ms: 5000,     // gap between progressive calls
      max_retries: 2,
      retry_delay_ms: 60000,
    };
  }

  /* ---------- Campaign CRUD ---------- */

  createCampaign({ name, script, voice, from, connection_id, ...opts } = {}) {
    const id = 'camp_' + crypto.randomUUID().slice(0, 8);
    const campaign = {
      id,
      name: name || 'Untitled Campaign',
      status: 'draft',          // draft | active | paused | completed
      script: script || '',
      voice: voice || this.defaults.voice,
      from: from || process.env.TELNYX_FROM_NUMBER,
      connection_id: connection_id || process.env.TELNYX_CONNECTION_ID,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      stats: { total: 0, dialed: 0, answered: 0, voicemail: 0, takeover: 0, failed: 0 },
      ...opts,
    };
    this.campaigns.set(id, campaign);
    this.leads.set(id, new Map());
    this.results.set(id, new Map());
    return campaign;
  }

  getCampaign(id) { return this.campaigns.get(id); }
  listCampaigns() { return [...this.campaigns.values()].map((c) => this.summary(c.id)); }

  summary(campaignId) {
    const c = this.campaigns.get(campaignId);
    const leads = this.leads.get(campaignId);
    const results = this.results.get(campaignId);
    return {
      id: c.id, name: c.name, status: c.status,
      total: leads ? leads.size : 0,
      stats: c.stats,
      updated_at: c.updated_at,
      active: this.active === campaignId,
    };
  }

  updateCampaign(campaignId, patch) {
    const c = this.campaigns.get(campaignId);
    if (!c) throw new Error(`Campaign ${campaignId} not found`);
    Object.assign(c, patch, { updated_at: new Date().toISOString() });
    return c;
  }

  deleteCampaign(campaignId) {
    this.campaigns.delete(campaignId);
    this.leads.delete(campaignId);
    this.results.delete(campaignId);
    if (this.active === campaignId) { this.active = null; this.dialing = false; }
    return true;
  }

  /* ---------- Leads ---------- */

  addLeads(campaignId, leads) {
    const map = this.leads.get(campaignId);
    if (!map) throw new Error(`Campaign ${campaignId} not found`);
    const c = this.campaigns.get(campaignId);
    const now = new Date().toISOString();
    const added = [];
    for (const raw of leads) {
      const id = 'lead_' + crypto.randomUUID().slice(0, 8);
      const lead = {
        id,
        campaign_id: campaignId,
        name: raw.name || '',
        number: raw.number,
        normalized: raw.number ? this.telnyx.norm(raw.number) : '',
        skip_trace: raw.skip_trace || null,
        dnc: !!raw.dnc,
        tags: raw.tags || [],
        custom_vars: raw.custom_vars || {},
        created_at: now,
      };
      map.set(id, lead);
      added.push(lead);
    }
    c.stats.total = map.size;
    c.updated_at = now;
    return added;
  }

  async importCsv(campaignId, filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];
    const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const idx = {};
    header.forEach((h, i) => { idx[h] = i; });
    const numberIdx = idx.phone !== undefined ? idx.phone : idx.number !== undefined ? idx.number : 0;
    const nameIdx = idx.name !== undefined ? idx.name : 1;
    const leads = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      leads.push({
        name: cols[nameIdx] || '',
        number: cols[numberIdx] || '',
        tags: (cols[idx.tags] || '').split(';').filter(Boolean),
      });
    }
    return this.addLeads(campaignId, leads);
  }

  getLeads(campaignId) {
    const map = this.leads.get(campaignId);
    if (!map) throw new Error(`Campaign ${campaignId} not found`);
    return [...map.values()];
  }

  getLead(campaignId, leadId) {
    return this.leads.get(campaignId)?.get(leadId);
  }

  updateLead(campaignId, leadId, patch) {
    const lead = this.getLead(campaignId, leadId);
    if (!lead) throw new Error('Lead not found');
    Object.assign(lead, patch);
    return lead;
  }

  /* ---------- Progressive dial loop ---------- */

  async start(campaignId) {
    const c = this.campaigns.get(campaignId);
    if (!c) throw new Error(`Campaign ${campaignId} not found`);
    if (c.status === 'active') return c;
    c.status = 'active';
    c.updated_at = new Date().toISOString();
    this.active = campaignId;
    if (!this.dialing) {
      this.dialing = true;
      this._runLoop(campaignId).catch((err) => {
        console.error('[campaign] dial loop error:', err);
        this.dialing = false;
      });
    }
    this.emit('campaign.started', c);
    return c;
  }

  pause(campaignId) {
    const c = this.campaigns.get(campaignId);
    if (!c) throw new Error(`Campaign ${campaignId} not found`);
    c.status = 'paused';
    c.updated_at = new Date().toISOString();
    this.emit('campaign.paused', c);
    return c;
  }

  resume(campaignId) { return this.start(campaignId); }

  stop(campaignId) {
    const c = this.campaigns.get(campaignId);
    if (!c) throw new Error(`Campaign ${campaignId} not found`);
    c.status = 'completed';
    c.updated_at = new Date().toISOString();
    this.active = null;
    this.dialing = false;
    this.emit('campaign.stopped', c);
    return c;
  }

  async _runLoop(campaignId) {
    while (this.active === campaignId && this.dialing) {
      const c = this.campaigns.get(campaignId);
      if (!c || c.status !== 'active') break;
      const leads = this.getLeads(campaignId);
      const results = this.results.get(campaignId);
      const next = leads.find((l) => !results.has(l.id) && !l.dnc);
      if (!next) {
        c.status = 'completed';
        c.updated_at = new Date().toISOString();
        this.active = null;
        this.dialing = false;
        this.emit('campaign.completed', c);
        break;
      }
      try {
        await this._dialLead(campaignId, next);
      } catch (err) {
        console.error(`[campaign] lead ${next.id} dial error:`, err.message);
        this._recordResult(campaignId, next.id, { disposition: 'failed', error: err.message });
      }
      if (this.active === campaignId && this.dialing) {
        await this._sleep(c.ring_delay_ms || this.defaults.ring_delay_ms);
      }
    }
    if (this.active === campaignId) this.dialing = false;
  }

  async _dialLead(campaignId, lead) {
    const c = this.campaigns.get(campaignId);
    const number = lead.normalized || lead.number;
    if (!number) throw new Error('Lead has no phone number');

    // Skip trace enrichment on first dial (carrier / line type)
    if (!lead.skip_trace) {
      try {
        lead.skip_trace = await this.telnyx.numberLookup(number);
      } catch (err) {
        console.warn(`[campaign] skip trace failed for ${number}:`, err.message);
      }
    }

    // Build personalized script from custom vars
    let script = c.script || '';
    for (const [k, v] of Object.entries(lead.custom_vars || {})) {
      script = script.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'g'), String(v));
    }
    script = script.replace(/\{\{\s*name\s*\}\}/g, lead.name || 'there');

    c.stats.dialed += 1;
    c.updated_at = new Date().toISOString();
    this.emit('call.started', { campaignId, lead });

    const call = await this.telnyx.placeCall({
      to: number,
      from: c.from,
      connection_id: c.connection_id,
      caller_id_name: c.caller_id_name,
      timeout_secs: c.timeout_secs || this.defaults.timeout_secs,
      answering_machine_detection: c.answering_machine_detection !== false,
      answering_machine_detection_url: `${this.baseUrl}/api/webhooks/telnyx/amd`,
      webhook_url: `${this.baseUrl}/api/webhooks/telnyx`,
      metadata: { campaign_id: campaignId, lead_id: lead.id },
    });

    const callControlId = call.call_control_id;
    const callRecord = {
      call_control_id: callControlId,
      lead_id: lead.id,
      number,
      voice: c.voice,
      language: c.language || this.defaults.language,
      script,
      started_at: new Date().toISOString(),
      status: 'ringing',
    };
    this.emit('call.placed', { campaignId, lead, call: callRecord });

    // Wait for the call to reach a terminal state via webhook-driven result.
    // The result promise resolves when routes/webhooks.js records a disposition for this call_control_id.
    const result = await this._waitForResult(callControlId, { timeoutMs: (c.timeout_secs || 30) * 1000 + 45000 });
    result.call_control_id = callControlId;
    result.lead = lead;
    this._recordResult(campaignId, lead.id, result);
    this.emit('call.completed', { campaignId, lead, result });
    return result;
  }

  /* Webhook-driven result resolution */

  recordCallEvent(callControlId, event) {
    // event: { type: 'call.answered'|'call.hangup'|'answering_machine_detected'|..., at, ... }
    const pending = this._pending.get(callControlId);
    if (!pending) return false;
    const { type, at } = event;
    if (type === 'call.answered') {
      pending.call.answered_at = at;
      pending.call.status = 'answered';
      // speak opener immediately (webhook means the calley picked up)
      this._announce(pending).catch((err) => console.error('[campaign] announce error:', err.message));
    }
    if (type === 'answering_machine_detected') {
      pending.call.status = 'voicemail';
      pending.disposition = 'voicemail';
      pending.voicemail_detected_at = at;
    }
    if (type === 'call.hangup') {
      pending.call.ended_at = at;
      pending.call.status = 'completed';
      pending.disposition = pending.disposition || (pending.call.answered_at ? 'answered' : 'no_answer');
      pending.call.duration_ms = pending.call.answered_at && at
        ? new Date(at) - new Date(pending.call.answered_at) : 0;
      pending.resolve(pending);
      this._pending.delete(callControlId);
    }
    return true;
  }

  requestTakeover(callControlId) {
    const pending = this._pending.get(callControlId);
    if (!pending) return false;
    pending.disposition = 'takeover';
    pending.takeover_requested_at = new Date().toISOString();
    this.emit('takeover.requested', { callControlId, lead: pending.lead, call: pending.call });
    return true;
  }

  _pending = new Map(); // callControlId -> { call, lead, resolve, reject, timer }

  _waitForResult(callControlId, { timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(callControlId);
        reject(new Error(`call ${callControlId} did not reach terminal state within timeout`));
      }, timeoutMs);
      this._pending.set(callControlId, { call: { status: 'ringing' }, resolve, reject, timer });
    });
  }

  async _announce({ campaignId, lead, call }) {
    const c = this.campaigns.get(campaignId);
    const { telnyx } = this;
    // First utterance lands within ~1s of pickup: tight retry loop in telnyx.speakWithRetry.
    await telnyx.speakWithRetry(call.call_control_id, call.script, {
      voice: call.voice,
      language: call.language,
    });
    call.announced_at = new Date().toISOString();
    this.emit('call.announced', { campaignId, lead, call });

    // Post-call actions: SMS follow-up + email notetaker summary, if configured
    if (c.sms_after_call) {
      try {
        await telnyx.sendSms({ from: c.from, to: lead.number, text: c.sms_after_call });
        call.sms_sent_at = new Date().toISOString();
      } catch (err) {
        console.warn('[campaign] SMS follow-up failed:', err.message);
      }
    }
  }

  _recordResult(campaignId, leadId, result) {
    const results = this.results.get(campaignId);
    results.set(leadId, result);
    const c = this.campaigns.get(campaignId);
    const key = result.disposition;
    if (c.stats[key] !== undefined) c.stats[key] += 1;
    c.updated_at = new Date().toISOString();
  }

  getResults(campaignId) {
    const map = this.results.get(campaignId);
    if (!map) throw new Error(`Campaign ${campaignId} not found`);
    return [...map.values()];
  }

  getResult(campaignId, leadId) {
    return this.results.get(campaignId)?.get(leadId);
  }

  _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
}

module.exports = { CampaignEngine };
