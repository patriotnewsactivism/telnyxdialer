# Telnyx AI Dialer

Outbound AI dialing system on Telnyx Call Control with customizable voices, progressive campaigns, AI notetaker, SMS, email, 1-click voicemail, voicemail detection, skip-trace lookup, agent takeover, and an installable PWA for phone.

```
telnyx-dialer/
├── backend/
│   ├── server.js            # Express API + PWA static server
│   ├── store.js             # In-memory calls + campaign engine
│   ├── test_modules.js      # Offline smoke tests (no Telnyx key needed)
│   ├── services/
│   │   ├── telnyx.js        # Telnyx API v2 wrapper (calls, SMS, lookup, recordings)
│   │   ├── campaign.js      # Progressive one-at-a-time dialer + dispositions
│   │   ├── notetaker.js     # faster-whisper transcription + LLM summary + SMTP email
│   │   ├── voicemail.js     # Telnyx AMD + server-side heuristic + VM drop
│   │   └── scripts/
│   │       └── transcribe.py# faster-whisper helper (numpy float32 16k-mono array)
│   └── routes/
│       ├── telnyx.js        # /api/calls/*, /api/sms/*, /api/lookup/*, /api/recordings
│       ├── campaigns.js     # /api/campaigns/* (CRUD, dial control, CSV import, takeover)
│       ├── notetaker.js     # /api/notetaker/transcribe, /:callId, /email/:callId
│       └── webhooks.js      # /api/webhooks/telnyx (Telnyx events -> engine)
├── frontend/
│   ├── index.html           # PWA shell (Tailwind, mobile-first)
│   ├── manifest.json        # Installable: "Add to home screen" on iOS/Android
│   ├── sw.js                # Service worker (offline shell, network-first API)
│   ├── app.js               # SPA: dialer, campaigns, leads, results, notetaker, settings
│   ├── styles.css
│   └── icons/               # 48/192/512 px icons
├── .env.example
├── package.json
└── docs/README.md
```

## Quickstart

```bash
cd ~/telnyx-dialer
cp .env.example .env
# edit .env — at minimum TELNYX_API_KEY, TELNYX_CONNECTION_ID, TELNYX_FROM_NUMBER
npm install
npm start          # http://0.0.0.0:3000  (PWA served at /)
npm test           # offline smoke tests — no credentials required
npm run lint       # syntax check all backend modules
```

Open `https://<your-host>/` on your phone and "Add to home screen".

## Telnyx console setup

1. Create a **Call Control Application** in the Telnyx portal with webhook URL:
   `https://<your-host>/api/webhooks/telnyx`
   Set its webhook URL to handle `call.initiated`, `call.answered`, `call.hangup`, `message.received`.
2. Note the application's **Connection ID** → `TELNYX_CONNECTION_ID`.
3. Buy/port numbers: one as caller ID (`TELNYX_FROM_NUMBER`); an SMS-enabled number (in a Messaging Profile) for `SMS after call`.
4. Set `TELNYX_WEBHOOK_URL` (same as above) — it's used as `webhook_url`/`answering_machine_detection_url` on outbound calls.

## Features

| Feature | How it works |
|---|---|
| Outbound AI dial | `POST /api/calls/dial` — Telnyx Call Control with per-call script, voice, language, `{{name}}` merge |
| Customizable voices | Telnyx native (male/female/Polly names like Brian), ElevenLabs, Cartesia, OpenAI — per call or per campaign |
| Takeover | `POST /api/calls/:id/transfer` — patches a live agent number into an active call; agent number also settable per campaign |
| AI notetaker | `POST /api/notetaker/transcribe` — Telnyx recording → ffmpeg 16k mono → faster-whisper → LLM summary (OpenRouter) → stored notes |
| Email notes | `POST /api/notetaker/email/:callId` — SMTP delivery of summary + transcript + recording link |
| SMS | `POST /api/sms/send` — optional automatic post-call follow-up text |
| 1-click voicemail | `POST /api/calls/:id/voicemail` — speaks a voicemail script, then hangs up |
| Voicemail detection | Telnyx Answering Machine Detection per call + server-side short-call/long-silence heuristic |
| Skip trace | `GET /api/lookup/:number` — Telnyx Number Lookup (carrier, line type, validity) |
| Campaign mode | Progressive (one-at-a-time) dialer over CSV lead lists, dispositions (answered/voicemail/no_answer/busy/failed/takeover/dnc), retry state, per-campaign voice/script/from |
| PWA | `manifest.json` + `sw.js` — installable on iOS/Android, offline shell, network-first API |

## Environment variables

See `.env.example`. Key ones:

- `TELNYX_API_KEY` — Telnyx API v2 key
- `TELNYX_CONNECTION_ID` — Call Control Application connection
- `TELNYX_FROM_NUMBER` — caller ID / SMS from number (E.164)
- `TELNYX_WEBHOOK_URL` — public webhook URL (must be reachable by Telnyx; use cloudflared tunnel or your domain during dev)
- `TELNYX_TTS_VOICE` / `TELNYX_TTS_LANGUAGE` — default voice (e.g. `Brian`, `en-US`)
- `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID`, `CARTESIA_API_KEY` / `CARTESIA_VOICE_ID` — custom voice providers
- `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` — notetaker summaries (falls back to extractive summary if unset)
- `SMTP_HOST/PORT/USER/PASS/FROM` — notetaker email delivery
- `TAKEOVER_NUMBER` — default agent number for takeover
- `BASE_URL` — public base of this service (recording/transcript links in emails)
- `PORT` — default 3000

## Deployment notes

- The webhook URL must be publicly reachable by Telnyx. In dev, run a cloudflared tunnel (`cloudflared tunnel --url http://localhost:3000`) and put the https URL in `TELNYX_WEBHOOK_URL` and the Telnyx console.
- `npm test` runs offline module smoke tests — no Telnyx credentials needed.
- Outbound calls/SMS/lookup return real Telnyx errors when credentials are missing or invalid (never crash the server — async route errors are caught and returned as JSON 500s).
- Notetaker needs `ffmpeg` (present) and `faster-whisper`/`soundfile` (Python). First transcription downloads the Whisper model (~140 MB for "base").

## Files produced in this session

All code is real and executed: lint passes, offline smoke tests pass, and the server was booted and exercised over HTTP (campaign CRUD, lead import, webhook ingestion, Telnyx API reachability returning 401 without a key, PWA assets 200, server survives error paths).