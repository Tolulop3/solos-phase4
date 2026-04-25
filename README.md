# SolOS Phase 4 — Autonomous Cycle Engine

Runs every 15 minutes automatically. Telegram is the entire interface.

## Deploy to Render.com (free, takes 5 minutes)

### Step 1 — Push to GitHub

1. Create a new GitHub repo called `solos-phase4`
2. Upload these 3 files to the root:
   - `server.js`
   - `solos-engine.js`
   - `package.json`

### Step 2 — Create Render service

1. Go to render.com — sign up free
2. Click **New** → **Web Service**
3. Connect your GitHub account
4. Select the `solos-phase4` repo
5. Settings:
   - **Name**: solos-phase4
   - **Runtime**: Node
   - **Build command**: `npm install`
   - **Start command**: `node server.js`
   - **Plan**: Free

### Step 3 — Add environment variables

In Render dashboard → your service → **Environment** tab, add:

| Key | Value |
|-----|-------|
| `TELEGRAM_BOT_TOKEN` | your bot token from BotFather |
| `TELEGRAM_CHAT_ID` | `6142943061` |
| `WALLET_ADDRESS` | `CjApZoSeUaSi5ssxwCxwV5kTvgNwnSe8Qdv9pk3pjHaW` |
| `HELIUS_API_KEY` | `b1a0c88f-5d8e-4738-8974-3ce353158248` |

### Step 5 — Prevent free tier sleep (REQUIRED)

Render free tier sleeps after 15 minutes of inactivity — which would stop your cycles.

Fix using UptimeRobot (free):
1. Go to uptimerobot.com — sign up free
2. Add New Monitor → HTTP(s)
3. URL: `https://your-render-url.onrender.com/health`
4. Interval: every 5 minutes
5. Save

This pings your server every 5 minutes keeping it permanently awake. The `/health` endpoint returns current cycle count and status so you can also use it to verify the server is running.

## How it works

- Runs a full 7-step cycle every 15 minutes automatically
- Silent cycles (stake/hold) only notify every 4th cycle to avoid spam
- Trade proposals and position alerts always notify immediately
- State persists across restarts in `state.json`

## Telegram commands

| Command | What it does |
|---------|-------------|
| `/start` | Show welcome + command list |
| `/status` | Current system state |
| `/run` | Trigger a manual cycle now |
| `/position` | Check open position details |
| `/pause` | Pause auto-cycles |
| `/resume` | Resume auto-cycles |
| `/balance` | Check real wallet balance |

## Trade approval flow

1. System detects expansion regime + sanity passes
2. Telegram message arrives with trade details
3. Tap ✅ Approve
4. Jupiter link sent to your Telegram
5. Tap link → opens in browser → MetaMask mobile pops up
6. Confirm in MetaMask
7. Done

## Important notes

- Free Render tier spins down after 15 minutes of inactivity
- The cron job keeps it alive by running every 15 minutes
- State file persists between restarts so nothing is lost
- Helius free tier: 100k requests/month — 15min cycles use ~9k/month
