'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'telnyx-dialer', telnyx_configured: !!process.env.TELNYX_API_KEY, base_url: BASE_URL });
});

const telnyxRoutes = require(path.join(__dirname, './routes/telnyx.js'));
const campaignRoutes = require(path.join(__dirname, './routes/campaigns.js'));
const notetakerRoutes = require(path.join(__dirname, './routes/notetaker.js'));
const webhookRoutes = require(path.join(__dirname, './routes/webhooks.js'));

app.use('/api', telnyxRoutes);
app.use('/api', campaignRoutes);
app.use('/api', notetakerRoutes);
webhookRoutes(app);

/* Serve the PWA frontend from /frontend */
app.use(express.static(path.join(__dirname, '../frontend'), { index: 'index.html', extensions: ['html'] }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'telnyx-dialer', telnyx_configured: !!process.env.TELNYX_API_KEY, base_url: BASE_URL });
});

app.use((_req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'internal server error' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`telnyx-dialer listening on http://0.0.0.0:${PORT}  (PWA at /)`);
  console.log(`  Telnyx configured: ${!!process.env.TELNYX_API_KEY}`);
  console.log(`  Webhook URL for Telnyx console: ${BASE_URL}/api/webhooks/telnyx`);
});

module.exports = { app, server };
