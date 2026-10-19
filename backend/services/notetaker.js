'use strict';

/*
 * AI Notetaker — records a call, transcribes it with faster-whisper (local, private),
 * summarizes with an LLM (OpenRouter), and can email the notes.
 *
 * Pipeline: Telnyx recording -> ffmpeg (16k mono wav) -> faster-whisper (numpy float32 array)
 * -> LLM summary -> stored notes -> optional SMTP email with recording + transcript links.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { dispatch } = require('undici');
const { downloadRecording } = require('./telnyx');

const SCRATCH = path.join(__dirname, '..', 'cache', 'notetaker');
fs.mkdirSync(SCRATCH, { recursive: true });

const OPENROUTER = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3.5-super-vl:free';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const SMTP_FROM = process.env.SMTP_FROM || 'ai-dialer@example.com';

const WHISPER_MODEL = process.env.WHISPER_MODEL || 'base';
const PY_SCRIPT = path.join(__dirname, 'scripts', 'transcribe.py');

/* ---------- LLM summary ---------- */

async function summarize(text, { language = 'en' } = {}) {
  const prompt = `You are a careful call-notetaker. Summarize the following phone-call transcript into:
1) One-sentence outcome
2) Key facts (names, numbers, dates, commitments)
3) Action items with owners (or "none")
4) Sentiment: positive / neutral / negative
Transcript:
${text}`;

  if (OPENROUTER) {
    try {
      const res = await dispatch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': BASE_URL,
          'X-Title': 'telnyx-dialer notetaker',
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
        }),
      });
      const body = await res.json();
      const choice = body.choices?.[0];
      if (choice && choice.message && choice.message.content) {
        return choice.message.content.trim();
      }
    } catch (err) {
      console.warn('[notetaker] OpenRouter summary failed, falling back:', err.message);
    }
  }
  /* Fallback: extractive summary — first N sentences of the transcript */
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const head = sentences.slice(0, 6).join(' ');
  return `Extractive summary (no LLM key configured):\n- Outcome: call completed, transcript captured.\n- Key points: ${head || '(no speech detected)'}\n- Action items: none detected automatically.\n- Sentiment: neutral`;
}

/* ---------- Transcribe ---------- */

async function transcribeAudio(wavPath) {
  const { spawnSync } = require('child_process');
  const python = process.env.PYTHON_BIN || 'python3';
  const result = spawnSync(python, [PY_SCRIPT, wavPath, WHISPER_MODEL], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: 600000,
  });
  if (result.status !== 0) {
    const err = new Error(`faster-whisper failed: ${result.stderr || result.output}`);
    err.code = 'TRANSCRIBE_FAILED';
    throw err;
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch (e) {
    parsed = { text: result.stdout.trim(), segments: [] };
  }
  return parsed;
}

async function transcribeRecording({ recordingUrl, recordingId, destDir = SCRATCH, language } = {}) {
  if (!recordingUrl && !recordingId) {
    throw new Error('provide recordingUrl or recordingId');
  }
  const id = recordingId || path.basename(recordingUrl).replace(/\?.*$/, '').replace(/[^a-z0-9_-]/gi, '_') || 'rec';
  const mp3Path = path.join(destDir, `${id}.mp3`);
  const wavPath = path.join(destDir, `${id}.16k.wav`);

  if (recordingUrl) {
    await downloadRecording(recordingUrl, mp3Path);
  } else {
    // recordingId: resolve media URL via Telnyx recordings list (fallback)
    const { getRecordings } = require('./telnyx');
    const { data } = await getRecordings();
    const rec = (data.data || data).find((r) => r.id === recordingId || r.recording_id === recordingId);
    if (!rec) throw new Error(`recording ${recordingId} not found`);
    await downloadRecording(rec.media_url || rec.url, mp3Path);
  }

  /* ffmpeg -> 16 kHz mono PCM wav (faster-whisper expects 16k mono input) */
  execFileSync('ffmpeg', [
    '-y', '-i', mp3Path, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath,
  ], { stdio: 'pipe' });

  const { text, segments } = await transcribeAudio(wavPath);
  const summary = await summarize(text, { language });

  return {
    recording_id: id,
    recording_url: recordingUrl,
    transcribed_at: new Date().toISOString(),
    language,
    text,
    segments: segments || [],
    summary,
    note_url: `${BASE_URL}/api/notetaker/${id}`,
  };
}

/* ---------- Notes store (in-memory) ---------- */

const notes = new Map();

function saveNotes(callId, note) { notes.set(callId, note); return note; }
function getNotes(callId) { return notes.get(callId); }
function listNotes() { return [...notes.values()]; }

/* ---------- Email delivery ---------- */

async function emailNotes(callId, { to, subject, from = SMTP_FROM } = {}) {
  const note = notes.get(callId);
  if (!note) throw new Error(`no notes for call ${callId}`);
  if (!to) throw new Error('recipient "to" required');

  const nodemailer = require('nodemailer');
  if (!process.env.SMTP_HOST) {
    throw new Error('SMTP not configured: set SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM');
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });

  const html = `
<h2>Call notes — ${callId}</h2>
<p><strong>Outcome summary:</strong></p>
<pre>${escapeHtml(note.summary || '')}</pre>
<p><strong>Transcript:</strong></p>
<pre>${escapeHtml(note.text || '')}</pre>
<p><strong>Recording:</strong> ${note.recording_url || 'n/a'}</p>
<p><strong>Transcribed at:</strong> ${note.transcribed_at}</p>
`;
  await transporter.sendMail({
    from,
    to,
    subject: subject || `Call notes — ${callId}`,
    html,
    text: `Call notes — ${callId}\n\n${note.summary || ''}\n\nTranscript:\n${note.text || ''}\n\nRecording: ${note.recording_url || 'n/a'}`,
  });
  return { sent: true, to, callId };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = {
  transcribeRecording,
  summarize,
  saveNotes,
  getNotes,
  listNotes,
  emailNotes,
  SCRATCH,
};
