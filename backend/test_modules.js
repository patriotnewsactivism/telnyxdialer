#!/usr/bin/env node
/* Smoke test: all backend modules load and syntax is valid. No Telnyx credentials needed. */
const assert = require('node:assert');
const telnyx = require('./services/telnyx');
const { CampaignEngine } = require('./services/campaign');
const notetaker = require('./services/notetaker');
const voicemail = require('./services/voicemail');

const engine = new CampaignEngine({ telnyx, notetaker, baseUrl: 'http://localhost' });
const c = engine.createCampaign({ name: 'Smoke test', script: 'Hi {{name}}, this is a test.', voice: 'Brian' });
engine.addLeads(c.id, [{ name: 'Sam', number: '+15550001234', custom_vars: { name: 'Sam' } }]);
assert.strictEqual(c.script.replace('{{name}}', 'Sam'), 'Hi Sam, this is a test.');
assert.strictEqual(telnyx.norm('(832) 975-7665'), '+18329757665');
assert.strictEqual(telnyx.norm('+18329757665'), '+18329757665');
assert.strictEqual(telnyx.norm('18329757665'), '+18329757665');
assert.strictEqual(typeof voicemail.detectFromEvent, 'function');
assert.strictEqual(typeof notetaker.transcribeRecording, 'function');
assert.strictEqual(engine.getLeads(c.id).length, 1);
assert.strictEqual(engine.getCampaign(c.id).stats.total, 1);

const heur = voicemail.serverSideHeuristic({
  started_at: new Date(Date.now() - 100000).toISOString(),
  answered_at: new Date(Date.now() - 90000).toISOString(),
  ended_at: new Date(Date.now() - 86000).toISOString(),
});
assert.strictEqual(heur.voicemail, true);

console.log('all module smoke tests passed');
