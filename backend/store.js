'use strict';

const path = require('path');

/* shared in-memory store: live calls + campaign engine instance */
const { CampaignEngine } = require(path.join(__dirname, './services/campaign.js'));
const telnyx = require(path.join(__dirname, './services/telnyx.js'));

const calls = new Map(); // call_control_id -> call record
const engine = new CampaignEngine({
  telnyx,
  notetaker: require(path.join(__dirname, './services/notetaker.js')),
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
});

function putCall(call) { calls.set(call.call_control_id, call); return call; }
function getCall(callControlId) { return calls.get(callControlId); }
function listCalls() { return [...calls.values()].sort((a, b) => new Date(b.started_at || 0) - new Date(a.started_at || 0)); }
function removeCall(callControlId) { calls.delete(callControlId); }

module.exports = { calls, putCall, getCall, listCalls, removeCall, engine, telnyx };
