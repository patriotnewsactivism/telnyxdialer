'use strict';

/*
 * Telnyx service — thin wrapper over Telnyx API v2.
 * Reads keys from env; every write hits Telnyx live, reads are cached by the caller.
 * Docs patterns encoded from telephony/telnyx-phone-system skill:
 *   - dial connection = TELNYX_CONNECTION_ID (Call Control App w/ valid webhook URL)
 *   - `from` can be any owned number, it need not belong to the connection
 *   - speak() works only after answer -> caller must retry until 200 (~0.3s loop)
 *   - voice: male/female on BuildMyBot-style connection; Polly names (Brian, ...) on others
 *   - SMS from must belong to a Telnyx Messaging Profile
 *   - answering_machine_detection flag on /v2/calls for voicemail detection
 */

const API = 'https://api.telnyx.com/v2';
const API_KEY = process.env.TELNYX_API_KEY;
const DEFAULT_CONNECTION = process.env.TELNYX_CONNECTION_ID;
const DEFAULT_FROM = process.env.TELNYX_FROM_NUMBER;

if (!API_KEY) {
  // Not fatal at import time; routes return a clear 500 when actually used.
  console.warn('[telnyx] TELNYX_API_KEY not set — outbound calls/SMS will fail until configured');
}

function norm(n) {
  if (!n) return n;
  let s = String(n).replace(/[\s\-().]/g, '');
  if (s.startsWith('+')) return s;
  if (s.startsWith('1') && s.length === 11) return '+' + s;   // already has country code
  if (s.length === 10) return '+1' + s;                        // US/Canada -> E.164
  return '+' + s;
}

function headers(extra = {}) {
  return {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function request(method, path, body, { retries = 2 } = {}) {
  const url = path.startsWith('http') ? path : `${API}${path}`;
  const opts = {
    method,
    headers: headers(),
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: body ? JSON.stringify(body) : undefined }),
  };
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, opts);
      const text = await res.text();
      let json = null;
      if (text) {
        try { json = JSON.parse(text); } catch (_) { json = { _raw: text }; }
      }
      if (res.status >= 400) {
        const err = new Error(`Telnyx ${method} ${path} -> ${res.statusCode}: ${JSON.stringify(json)}`);
        err.status = res.status;
        err.telnyxBody = json;
        throw err;
      }
      return { status: res.statusCode, data: json, headers: res.headers };
    } catch (err) {
      lastErr = err;
      if (err.status === 429 && i < retries) {
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/* ---------- Calls ---------- */

async function placeCall({
  to,
  from = DEFAULT_FROM,
  connection_id = DEFAULT_CONNECTION,
  caller_id_name,
  timeout_secs = 30,
  answering_machine_detection = false,
  answering_machine_detection_url,
  webhook_url,
  stream_url,        // media stream url for AI voice (Vapi/Cartesia-style websocket audio)
  stream_timeout_secs,
  custom_headers,
  metadata,
} = {}) {
  const body = {
    connection_id,
    to: norm(to),
    from: norm(from),
    timeout_secs,
    answering_machine_detection,
  };
  if (caller_id_name) body.caller_id_name = caller_id_name;
  if (answering_machine_detection_url) body.answering_machine_detection_url = answering_machine_detection_url;
  if (webhook_url) body.webhook_url = webhook_url;
  if (stream_url) body.stream_url = stream_url;
  if (stream_timeout_secs) body.stream_timeout_secs = stream_timeout_secs;
  if (custom_headers) body.custom_headers = custom_headers;
  if (metadata) body.metadata = metadata;
  const { data } = await request('POST', '/calls', body);
  return data;
}

async function getCall(callControlId) {
  const { data } = await request('GET', `/calls/${encodeURIComponent(callControlId)}`);
  return data;
}

/* Call Control actions — speak only after answer; caller retries on 422 "not answered yet" */

async function speak(callControlId, text, { voice, language = 'en-US', loop = 0 } = {}) {
  const body = { text, voice, language, loop };
  const { data } = await request('POST', `/calls/${encodeURIComponent(callControlId)}/actions/speak`, body);
  return data;
}

/*
 * speakWithRetry — tight ~0.3s retry loop until the call is answered, then speaks.
 * This is the pickup signal: a 200 means the callee picked up; 422 "Call not answered yet"
 * means still ringing. Returns when speak lands or throws the last error after the window.
 */
async function speakWithRetry(callControlId, text, opts = {}, { maxSeconds = 25, intervalMs = 300 } = {}) {
  const deadline = Date.now() + maxSeconds * 1000;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return await speak(callControlId, text, opts);
    } catch (err) {
      lastErr = err;
      const msg = (err.telnyxBody && JSON.stringify(err.telnyxBody)) || err.message;
      // 422 "Call not answered yet" -> keep retrying. 422 "Invalid value for voice" means
      // the call IS answered but the voice name is rejected -> surface immediately so the
      // caller can switch to a valid voice instead of burning the retry window.
      if (err.status === 422 && /invalid value for voice/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw lastErr || new Error(`speakWithRetry timed out after ${maxSeconds}s`);
}

async function recordStart(callControlId) {
  const { data } = await request('POST', `/calls/${encodeURIComponent(callControlId)}/actions/record_start`);
  return data;
}
async function recordStop(callControlId) {
  const { data } = await request('POST', `/calls/${encodeURIComponent(callControlId)}/actions/record_stop`);
  return data;
}
async function getRecordings() {
  const { data } = await request('GET', '/recordings');
  return data;
}

/* Transfer a live call to a human (takeover) or another destination */
async function transfer(callControlId, { to, from = DEFAULT_FROM, caller_id_name } = {}) {
  const body = { to: norm(to), from: norm(from) };
  if (caller_id_name) body.caller_id_name = caller_id_name;
  const { data } = await request('POST', `/calls/${encodeURIComponent(callControlId)}/actions/transfer`, body);
  return data;
}
async function hangup(callControlId) {
  const { data } = await request('POST', `/calls/${encodeURIComponent(callControlId)}/actions/hangup`);
  return data;
}
async function sendDtmf(callControlId, { digits }) {
  const { data } = await request('POST', `/calls/${encodeURIComponent(callControlId)}/actions/send_dtmf`, { digits });
  return data;
}

/* ---------- SMS ---------- */

async function sendSms({ from, to, text, media_urls, messaging_profile_id }) {
  const body = {
    from: norm(from),
    to: norm(to),
    text,
  };
  if (media_urls) body.media_urls = media_urls;
  if (messaging_profile_id) body.messaging_profile_id = messaging_profile_id;
  const { data } = await request('POST', '/messages', body);
  return data;
}

async function getMessage(messageId) {
  const { data } = await request('GET', `/messages/${encodeURIComponent(messageId)}`);
  return data;
}

/* ---------- Number lookup (skip trace lite: carrier / line type / validity) ---------- */

async function numberLookup(number) {
  const { data } = await request('GET', `/number_lookup/${encodeURIComponent(norm(number))}`);
  return data;
}

/* ---------- Media helpers ---------- */

/* Download a Telnyx recording to a local path (used by the notetaker) */
async function downloadRecording(url, destPath) {
  const fs = await import('fs');
  const res = await fetch(url);
  if (res.status >= 400) throw new Error(`Recording download failed ${res.status}`);
  const stream = res.body;
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    stream.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    stream.pipe(out);
  });
}

module.exports = {
  API, API_KEY, norm, headers, request,
  placeCall, getCall, speak, speakWithRetry,
  recordStart, recordStop, getRecordings,
  transfer, hangup, sendDtmf,
  sendSms, getMessage,
  numberLookup,
  downloadRecording,
};
