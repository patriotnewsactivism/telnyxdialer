'use strict';

const path = require('path');

/* Direct-call routes: dial, speak, record, transfer (takeover), hangup, voicemail drop, SMS, lookup */

const express = require('express');
const router = express.Router();
const telnyx = require(path.join(__dirname, '../services/telnyx.js'));
const voicemail = require(path.join(__dirname, '../services/voicemail.js'));
const { putCall, getCall, listCalls, engine } = require(path.join(__dirname, '../store.js'));

router.use(express.json());
const catchAsync = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* GET /api/calls — recent call records (from in-memory store; Telnyx reads are cached by the UI) */
router.get('/calls', (_req, res) => {
  res.json({ calls: listCalls(), count: listCalls().length });
});

router.get('/calls/:callControlId', catchAsync(async (req, res) => {
  const { callControlId } = req.params;
  const stored = getCall(callControlId);
  let live = null;
  try { live = await telnyx.getCall(callControlId); } catch (_) { /* live lookup optional */ }
  res.json({ call: stored, live });
}));

/* POST /api/calls/dial — single outbound dial (or campaign-managed dial) */
router.post('/calls/dial', catchAsync(async (req, res) => {
  const {
    to, from, connection_id, voice, language, script,
    answering_machine_detection, webhook_url, timeout_secs, caller_id_name,
    campaign_id, lead_id,
  } = req.body || {};

  if (!to) return res.status(400).json({ error: '"to" is required' });

  const call = await telnyx.placeCall({
    to, from, connection_id, caller_id_name,
    timeout_secs: timeout_secs ? Number(timeout_secs) : 30,
    answering_machine_detection: answering_machine_detection !== false,
    answering_machine_detection_url: webhook_url || `${process.env.BASE_URL || 'http://localhost:3000'}/api/webhooks/telnyx/amd`,
    webhook_url: webhook_url || `${process.env.BASE_URL || 'http://localhost:3000'}/api/webhooks/telnyx`,
    stream_url: req.body.stream_url,         // optional: Vapi/Cartesia media stream for AI voice
    metadata: { campaign_id, lead_id, source: 'api' },
  });

  const callRecord = {
    call_control_id: call.call_control_id,
    number: to, from: from || process.env.TELNYX_FROM_NUMBER,
    voice, language, script, started_at: new Date().toISOString(), status: 'ringing',
    campaign_id, lead_id,
  };
  putCall(callRecord);
  res.status(201).json({ call: callRecord, telnyx: call });
}));

/* POST /api/calls/:callControlId/speak — say something on a live call (retries until answered) */
router.post('/calls/:callControlId/speak', catchAsync(async (req, res) => {
  const { callControlId } = req.params;
  const { text, voice, language } = req.body || {};
  if (!text) return res.status(400).json({ error: '"text" is required' });
  const result = await telnyx.speakWithRetry(callControlId, text, { voice, language });
  const call = getCall(callControlId);
  if (call) { call.announced_at = new Date().toISOString(); call.status = 'answered'; }
  res.json({ ok: true, call_control_id: callControlId, telnyx: result });
}));

/* POST /api/calls/:callControlId/record_start | record_stop */
router.post('/calls/:callControlId/record_start', catchAsync(async (req, res) => {
  const result = await telnyx.recordStart(req.params.callControlId);
  const call = getCall(req.params.callControlId);
  if (call) call.recording = true;
  res.json({ ok: true, telnyx: result });
}));
router.post('/calls/:callControlId/record_stop', catchAsync(async (req, res) => {
  const result = await telnyx.recordStop(req.params.callControlId);
  const call = getCall(req.params.callControlId);
  if (call) call.recording = false;
  res.json({ ok: true, telnyx: result });
}));

/* POST /api/calls/:callControlId/transfer — takeover: patch a live agent into the call */
router.post('/calls/:callControlId/transfer', catchAsync(async (req, res) => {
  const { callControlId } = req.params;
  const { to, from, caller_id_name } = req.body || {};
  if (!to) return res.status(400).json({ error: '"to" (takeover destination) is required' });
  const result = await telnyx.transfer(callControlId, { to, from, caller_id_name });
  const call = getCall(callControlId);
  if (call) { call.status = 'transferring'; call.takeover_to = to; call.transferred_at = new Date().toISOString(); }
  engine.recordCallEvent(callControlId, { type: 'call.hangup', at: new Date().toISOString(), payload: {} });
  res.json({ ok: true, call_control_id: callControlId, telnyx: result });
}));

/* POST /api/calls/:callControlId/hangup */
router.post('/calls/:callControlId/hangup', catchAsync(async (req, res) => {
  const result = await telnyx.hangup(req.params.callControlId);
  const call = getCall(req.params.callControlId);
  if (call) { call.status = 'completed'; call.ended_at = new Date().toISOString(); }
  res.json({ ok: true, telnyx: result });
}));

/* POST /api/calls/:callControlId/voicemail — 1-click voicemail drop */
router.post('/calls/:callControlId/voicemail', catchAsync(async (req, res) => {
  const { callControlId } = req.params;
  const { script, voice, language } = req.body || {};
  const result = await voicemail.dropVoicemail(callControlId, { script, voice, language });
  const call = getCall(callControlId);
  if (call) { call.status = 'completed'; call.voicemail_dropped = true; call.ended_at = new Date().toISOString(); }
  res.json({ ok: true, ...result });
}));

/* POST /api/sms/send */
router.post('/sms/send', catchAsync(async (req, res) => {
  const { from, to, text, media_urls } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: '"to" and "text" are required' });
  const result = await telnyx.sendSms({ from: from || process.env.TELNYX_FROM_NUMBER, to, text, media_urls });
  res.status(201).json({ ok: true, sms: result.data });
}));

/* GET /api/lookup/:number — skip trace lite: carrier, line type, validity via Telnyx Number Lookup */
router.get('/lookup/:number', catchAsync(async (req, res) => {
  const result = await telnyx.numberLookup(req.params.number);
  const data = result.data || result;
  const lineType = data.line_type || data.type || data.carrier?.line_type;
  const carrier = data.carrier?.name || data.carrier;
  res.json({ number: req.params.number, valid: !!data, line_type: lineType, carrier, raw: data });
}));

router.get('/recordings', async (_req, res) => {
  const result = await telnyx.getRecordings();
  res.json(result);
});

module.exports = router;
