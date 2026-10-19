'use strict';

const path = require('path');

/* Notetaker routes: transcribe a recording, fetch notes, email notes */

const express = require('express');
const router = express.Router();
const notetaker = require(path.join(__dirname, '../services/notetaker.js'));
const telnyx = require(path.join(__dirname, '../services/telnyx.js'));

router.use(express.json());
const catchAsync = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* POST /api/notetaker/transcribe — body: { recording_url? | recording_id?, language?, call_id? } */
router.post('/transcribe', catchAsync(async (req, res) => {
  const { recording_url, recording_id, language, call_id } = req.body || {};
  const note = await notetaker.transcribeRecording({ recording_url, recording_id, language });
  if (call_id) notetaker.saveNotes(call_id, note);
  res.status(201).json({ note });
}));

/* GET /api/notetaker/:callId — stored transcript + summary */
router.get('/:callId', (req, res) => {
  const note = notetaker.getNotes(req.params.callId);
  if (!note) return res.status(404).json({ error: 'no notes for this call' });
  res.json({ note });
});

/* POST /api/notetaker/email/:callId — body: { to, subject?, from? } */
router.post('/email/:callId', catchAsync(async (req, res) => {
  const { to, subject, from } = req.body || {};
  const result = await notetaker.emailNotes(req.params.callId, { to, subject, from });
  res.json({ ok: true, ...result });
}));

module.exports = router;
