'use strict';

/*
 * Voicemail handling:
 * 1) Telnyx Answering Machine Detection (AMD) — enabled per call; Telnyx posts an
 *    answering machine event to the webhook (routes/webhooks.js maps it).
 * 2) Server-side best-effort heuristic — a connected call that ends within a few
 *    seconds of the opener, or never produces speech audio, is likely a machine/IVR.
 * 3) 1-click voicemail drop — speak a voicemail script on a connected call, then hang up.
 */

const { telnyx } = require('./telnyx');

const SHORT_CALL_MS = 4000; /* answered then hung up inside this window => likely voicemail */

function detectFromEvent(event) {
  /* Telnyx AMD webhook payloads vary by product; normalize what we can. */
  const type = String(event.type || '').toLowerCase();
  const payload = event.payload || event;
  const answeredBy = String(payload.answered_by || payload.detected_as || '').toLowerCase();
  if (type.includes('answering_machine') || answeredBy.includes('machine') || answeredBy === 'fax') {
    return { voicemail: true, confidence: 'high', source: 'telnyx_amd' };
  }
  if (answeredBy === 'human' || answeredBy === 'person') {
    return { voicemail: false, confidence: 'high', source: 'telnyx_amd' };
  }
  return null;
}

function serverSideHeuristic(callRecord) {
  const started = callRecord.started_at ? new Date(callRecord.started_at) : null;
  const answered = callRecord.answered_at ? new Date(callRecord.answered_at) : null;
  const ended = callRecord.ended_at ? new Date(callRecord.ended_at) : null;
  const announced = callRecord.announced_at ? new Date(callRecord.announced_at) : null;

  if (answered && ended) {
    const talkMs = ended - answered;
    if (talkMs <= SHORT_CALL_MS && !callRecord.user_speech_detected) {
      return { voicemail: true, confidence: 'low', source: 'heuristic_short_call', talk_ms: talkMs };
    }
    if (announced && ended && (ended - announced) <= 2500 && !callRecord.user_speech_detected) {
      /* opener played, caller hung up almost immediately => machine greeting */
      return { voicemail: true, confidence: 'low', source: 'heuristic_immediate_hangup', talk_ms: talkMs };
    }
  }
  if (answered && !ended && announced && Date.now() - announced > 25000) {
    /* connected, opener spoken, silence for 25s => likely voicemail greeting recording */
    return { voicemail: true, confidence: 'low', source: 'heuristic_long_silence' };
  }
  return { voicemail: false, confidence: 'none', source: 'heuristic_inconclusive' };
}

/*
 * 1-click voicemail drop on a live call: speak the voicemail message, wait for it to
 * finish, then hang up. Caller supplies script; defaults to a short professional VM.
 */
async function dropVoicemail(callControlId, { script, voice, language } = {}) {
  const text = script ||
    'Hi, this is an automated call from your AI dialer. We tried to reach you and would love to connect. ' +
    'Please call us back at your earliest convenience. Thank you.';
  await telnyx.speak(callControlId, text, { voice, language });
  /* speak() is non-blocking; give it a moment then hang up so the full message plays.
     Production should estimate duration (~150 wpm) before hangup — see telnyx-phone-system skill. */
  await new Promise((r) => setTimeout(r, Math.ceil(text.split(/\s+/).length / 150 * 60 * 1000) + 1500));
  await telnyx.hangup(callControlId);
  return { voicemail_dropped: true, call_control_id: callControlId };
}

module.exports = { detectFromEvent, serverSideHeuristic, dropVoicemail, SHORT_CALL_MS };
