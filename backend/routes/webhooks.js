'use strict';

const path = require('path');

/* Telnyx webhook: call events + answering-machine detection, message status.
   Telnyx posts JSON events here; the campaign engine consumes them for progressive dialing.
   This URL must be public (cloudflared tunnel or your domain) and entered in the Telnyx console
   as the Call Control App webhook URL and/or per-call webhook_url.
 */

const telnyx = require(path.join(__dirname, '../services/telnyx.js'));
const voicemail = require(path.join(__dirname, '../services/voicemail.js'));
const catchAsync = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = (app) => {
  const { engine, putCall, getCall, calls } = require(path.join(__dirname, '../store.js'));

  app.post('/api/webhooks/telnyx', catchAsync(async (req, res) => {
    try {
      const event = req.body || {};
      const type = event.event_type || event.type || event.event;
      const payload = event.payload || event;
      const callControlId = payload.call_control_id || payload.call_leg_id || event.call_control_id;
      const at = payload.timestamp || event.timestamp || new Date().toISOString();

      let call = callControlId ? getCall(callControlId) : null;
      if (!call && callControlId) {
        call = { call_control_id: callControlId, started_at: at, status: 'initiated' };
        putCall(call);
      }

      /* ---------- Call lifecycle ---------- */
      if (type === 'call.initiated' || type === 'call.ringing') {
        if (call) { call.status = type === 'call.initiated' ? 'initiated' : 'ringing'; call.updated_at = at; }
        return res.status(200).json({ received: true });
      }

      if (type === 'call.answered') {
        if (call) {
          call.status = 'answered';
          call.answered_at = at;
          call.from = payload.from || call.from;
          call.to = payload.to || call.to;
          call.direction = payload.direction || call.direction;
          /* Telnyx AMD: answered_by indicates human / machine */
          const amd = voicemail.detectFromEvent({ type, payload });
          if (amd) { call.voicemail = amd; call.amd_confidence = amd.confidence; }
        }
        return res.status(200).json({ received: true });
      }

      if (type === 'answering_machine_detected' || type === 'call.machine_detected') {
        if (call) {
          call.voicemail = { voicemail: true, confidence: 'high', source: 'telnyx_amd' };
          call.amd_confidence = 'high';
          call.status = 'voicemail';
        }
        const engineResult = engine.recordCallEvent(callControlId, { type: 'answering_machine_detected', at, payload });
        return res.status(200).json({ received: true, engine: !!engineResult });
      }

      if (type === 'call.hangup' || type === 'call.ended') {
        if (call) {
          call.status = 'completed';
          call.ended_at = at;
          call.duration_ms = call.answered_at ? new Date(at) - new Date(call.answered_at) : 0;
          call.hangup_cause = payload.hangup_cause || payload.disconnect_cause;
          /* Heuristic voicemail detection when Telnyx didn't report AMD */
          if (!call.voicemail) {
            call.voicemail = voicemail.serverSideHeuristic(call);
          }
        }
        const engineResult = engine.recordCallEvent(callControlId, {
          type: 'call.hangup', at, payload,
          disposition: call && call.voicemail && call.voicemail.voicemail ? 'voicemail' : undefined,
        });
        return res.status(200).json({ received: true, engine: !!engineResult });
      }

      if (type === 'call.dtmf') {
        return res.status(200).json({ received: true });
      }

      /* ---------- SMS ---------- */
      if (type === 'message.received' || type === 'message.status') {
        const msg = { id: payload.id || event.id, to: payload.to, from: payload.from, text: payload.text, type, at };
        if (!calls.sms) calls.sms = [];
        calls.sms.push(msg);
        return res.status(200).json({ received: true });
      }

      return res.status(200).json({ received: true, note: `unhandled event type: ${type}` });
    } catch (err) {
      console.error('[webhook] error:', err.message);
      return res.status(500).json({ error: err.message });
    }
}));  
}
