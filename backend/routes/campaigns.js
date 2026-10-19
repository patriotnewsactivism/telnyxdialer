'use strict';

const path = require('path');

/* Campaign routes — CRUD, progressive dial control, lead CSV import, results, takeover */

const express = require('express');
const multer = require('multer');
const router = express.Router();
const { engine } = require(path.join(__dirname, '../store.js'));

router.use(express.json());
const catchAsync = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const upload = multer({ dest: process.env.UPLOAD_DIR || '/tmp/telnyx-dialer-uploads', limits: { fileSize: 10 * 1024 * 1024 } });

/* List campaigns with stats */
router.get('/campaigns', (_req, res) => {
  res.json({ campaigns: engine.listCampaigns(), count: engine.listCampaigns().length });
});

/* Create a campaign */
router.post('/campaigns', (req, res) => {
  const c = engine.createCampaign(req.body || {});
  res.status(201).json({ campaign: c });
});

router.get('/campaigns/:id', (req, res) => {
  const c = engine.getCampaign(req.params.id);
  if (!c) return res.status(404).json({ error: 'campaign not found' });
  res.json({ campaign: c, leads: engine.getLeads(req.params.id).length, results: engine.getResults(req.params.id).length });
});

router.delete('/campaigns/:id', (req, res) => {
  engine.deleteCampaign(req.params.id);
  res.json({ ok: true });
});

/* Progressive dial control */
router.post('/campaigns/:id/start', catchAsync(async (req, res) => {
  const c = await engine.start(req.params.id);
  res.json({ campaign: c, status: c.status });
}));
router.post('/campaigns/:id/pause', (req, res) => res.json({ campaign: engine.pause(req.params.id) }));
router.post('/campaigns/:id/resume', catchAsync(async (req, res) => {
  const c = await engine.resume(req.params.id);
  res.json({ campaign: c, status: c.status });
}));
router.post('/campaigns/:id/stop', (req, res) => res.json({ campaign: engine.stop(req.params.id) }));

/* Leads */
router.get('/campaigns/:id/leads', (req, res) => {
  res.json({ leads: engine.getLeads(req.params.id), count: engine.getLeads(req.params.id).length });
});

router.post('/campaigns/:id/leads', upload.single('file'), catchAsync(async (req, res) => {
  let leads;
  if (req.file) {
    leads = await engine.importCsv(req.params.id, req.file.path);
  } else if (req.body && Array.isArray(req.body.leads)) {
    leads = engine.addLeads(req.params.id, req.body.leads);
  } else if (req.body && req.body.name && req.body.number) {
    leads = engine.addLeads(req.params.id, [req.body]);
  } else {
    return res.status(400).json({ error: 'send file (csv), {leads: [...]}, or a single lead object' });
  }
  res.status(201).json({ leads, count: leads.length });
}));

router.get('/campaigns/:id/results', (req, res) => {
  const results = engine.getResults(req.params.id);
  res.json({ results, count: results.length });
});

/* Agent takeover of a live call in a campaign */
router.post('/campaigns/:id/takeover', catchAsync(async (req, res) => {
  const { call_control_id, to } = req.body || {};
  if (!call_control_id || !to) {
    return res.status(400).json({ error: '"call_control_id" and "to" (agent number) required' });
  }
  const c = engine.getCampaign(req.params.id);
  if (!c) return res.status(404).json({ error: 'campaign not found' });
  const requested = engine.requestTakeover(call_control_id);
  if (!requested) return res.status(404).json({ error: 'no live call with that call_control_id' });
  const result = await require(path.join(__dirname, '../services/telnyx.js')).transfer(call_control_id, { to });
  res.json({ ok: true, takeover: true, telnyx: result });
}));

module.exports = router;
