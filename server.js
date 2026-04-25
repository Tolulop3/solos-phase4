'use strict';

const TelegramBot = require('node-telegram-bot-api');
const cron        = require('node-cron');
const fs          = require('fs');
const path        = require('path');
const { runCycle, fetchWalletBalance } = require('./solos-engine');

// ── CONFIG FROM ENV ──────────────────────────────────────────────────────────
const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID     = process.env.TELEGRAM_CHAT_ID;
const WALLET_ADDR = process.env.WALLET_ADDRESS;
const PORT        = process.env.PORT || 3000;

if(!BOT_TOKEN || !CHAT_ID) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars');
  process.exit(1);
}

// ── STATE FILE (persists across restarts) ────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'state.json');

function loadState() {
  try {
    if(fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch(e) {}
  return {
    cycleNum:          0,
    totalSOL:          0.5,
    startSOL:          0.5,
    consecutiveWins:   0,
    consecutiveLosses: 0,
    recoveryMode:      false,
    unlockLevel:       2,   // starts at 2 since we've already validated
    openPosition:      null,
    history:           [],
    pendingProposal:   null,
    paused:            false
  };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch(e) {
    console.error('State save failed:', e.message);
  }
}

let state = loadState();

const JSONBIN_KEY  = process.env.JSONBIN_KEY  || '';
const JSONBIN_BIN  = process.env.JSONBIN_BIN  || '';
const JSONBIN_BASE = 'https://api.jsonbin.io/v3/b';

// Write state to JSONBin so dashboard can read it
async function syncToDashboard(state, lastResult) {
  if(!JSONBIN_KEY || !JSONBIN_BIN) return;
  try {
    const payload = {
      cycleNum:          state.cycleNum,
      totalSOL:          state.totalSOL,
      unlockLevel:       state.unlockLevel,
      consecutiveWins:   state.consecutiveWins,
      consecutiveLosses: state.consecutiveLosses,
      recoveryMode:      state.recoveryMode,
      openPosition:      state.openPosition,
      paused:            state.paused,
      lastUpdated:       new Date().toISOString(),
      lastAction:        lastResult?.action || null,
      lastRegime:        lastResult?.regime?.dominant || null,
      lastSanity:        lastResult ? Math.round(lastResult.sanity * 100) : null,
      lastExpProb:       lastResult ? Math.round(lastResult.regime?.expProb * 100) : null,
      lastConfidence:    lastResult ? Math.round(lastResult.regime?.confidence * 100) : null,
      lastTradability:   lastResult ? Math.round(lastResult.scores?.tradability * 100) : null,
      lastFragility:     lastResult ? Math.round(lastResult.scores?.fragility * 100) : null,
      lastExecQuality:   lastResult ? Math.round(lastResult.scores?.execQuality * 100) : null,
      lastAggression:    lastResult?.scores?.aggressionMult || null,
      walletBalance:     lastResult?.walletBalance || null,
      solPrice:          lastResult?.solPrice || null,
      dataSource:        lastResult?.marketData?.source || null,
      recentHistory:     state.history?.slice(-10) || []
    };
    await fetch(`${JSONBIN_BASE}/${JSONBIN_BIN}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Key': JSONBIN_KEY
      },
      body: JSON.stringify(payload)
    });
  } catch(e) {
    console.log('JSONBin sync failed:', e.message);
  }
}

// ── MESSAGE FORMATTERS ───────────────────────────────────────────────────────
function regimeEmoji(regime) {
  if(regime === 'EXPANSION') return '🟢';
  if(regime === 'STRESS')    return '🔴';
  return '🟡';
}

function formatCycleAlert(result) {
  const r = result.regime;
  const s = result.scores;
  const lines = [
    `⚡ *SolOS Cycle ${result.cycleNum}*`,
    ``,
    `${regimeEmoji(r.dominant)} Regime: *${r.dominant}* ${Math.round(r.dominantProb*100)}%`,
    `📊 Confidence: ${Math.round(r.confidence*100)} | Sanity: ${Math.round(result.sanity*100)}`,
    `💧 Tradability: ${Math.round(s.tradability*100)} | Fragility: ${Math.round(s.fragility*100)}`,
    `💰 Wallet: ${result.walletBalance ? result.walletBalance.toFixed(4)+' SOL' : 'not connected'}`,
    ``,
    `Status: *${result.action}*`
  ];
  return lines.join('\n');
}

function formatTradeProposal(result) {
  const p = result.proposal;
  const sourceTag = p.dataSource === 'live' ? '🟢 live data' : '🟡 simulated data';
  const lines = [
    `🚀 *TRADE PROPOSED — Cycle ${result.cycleNum}*`,
    ``,
    `Action: SOL → *${p.token}* (Tier ${p.tier})`,
    `Amount: *${p.amountSOL} SOL*`,
    ``,
    `📉 Stop: -${p.stops.stopPct}%`,
    `📈 Target: +${p.stops.targetPct}%`,
    `🛡 Backstop: -${p.stops.backstopPct}%`,
    ``,
    `Regime: ${Math.round(result.regime.expProb*100)}% expansion`,
    `Sanity: ${Math.round(result.sanity*100)}/100`,
    `Price impact: ${p.priceImpact ? (p.priceImpact*100).toFixed(3)+'%' : 'n/a'}`,
    `Signal: ${sourceTag}`,
    ``,
    `Tap ✅ to approve or ❌ to skip`
  ];
  return lines.join('\n');
}

function formatPositionAlert(position, update) {
  const emoji = update.action === 'TARGET' ? '✅' : update.action === 'BACKSTOP' ? '🚨' : '⚠️';
  const lines = [
    `${emoji} *${update.action} — ${position.token}*`,
    ``,
    `P&L: *${update.pnlPct >= 0 ? '+' : ''}${update.pnlPct.toFixed(1)}%*`,
    `Entry: ${position.entryPrice.toFixed(4)} | Now: ${update.currentPrice.toFixed(4)}`,
    `Cycles held: ${update.cyclesHeld}`,
    ``,
    `Tap ✅ to exit or ❌ to hold`
  ];
  return lines.join('\n');
}

// ── SEND MESSAGE ─────────────────────────────────────────────────────────────
async function send(text, opts = {}) {
  try {
    await bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown', ...opts });
  } catch(e) {
    console.error('Telegram send failed:', e.message);
  }
}

// ── INLINE KEYBOARDS ─────────────────────────────────────────────────────────
const APPROVE_KB = {
  inline_keyboard: [[
    { text: '✅ Approve', callback_data: 'approve' },
    { text: '❌ Skip',    callback_data: 'skip' }
  ]]
};

const EXIT_KB = {
  inline_keyboard: [[
    { text: '✅ Exit now', callback_data: 'exit_approve' },
    { text: '❌ Hold',     callback_data: 'exit_skip' }
  ]]
};

// ── MAIN CYCLE RUNNER ─────────────────────────────────────────────────────────
async function executeCycle(manual = false) {
  if(state.paused && !manual) return;

  console.log(`Running cycle ${(state.cycleNum||0)+1}...`);

  try {
    const result = await runCycle(state, WALLET_ADDR);

    // Update state cycle count
    state.cycleNum = result.cycleNum;

    // Handle position update first
    if(result.positionUpdate && result.action === 'EXIT_NEEDED') {
      const msg = formatPositionAlert(state.openPosition, result.positionUpdate);
      state.pendingProposal = { type: 'EXIT', result };
      saveState(state);
      await send(msg, { reply_markup: EXIT_KB });
      return;
    }

    // Handle trade proposal
    if(result.action === 'TRADE_PROPOSED') {
      const msg = formatTradeProposal(result);
      state.pendingProposal = { type: 'ENTRY', result };
      saveState(state);
      await send(msg, { reply_markup: APPROVE_KB });
      return;
    }

    // Handle emergency
    if(result.action === 'EMERGENCY') {
      await send(`🚨 *EMERGENCY — Cycle ${result.cycleNum}*\nVolatility spike detected. All positions flattened. Vault only.`);
      if(state.openPosition) {
        state.openPosition = null;
        saveState(state);
      }
      return;
    }

    // Silent cycles — only notify every 4th cycle or if manual
    if(manual || result.cycleNum % 4 === 0) {
      const msg = formatCycleAlert(result);
      await send(msg);
    }

    // Update staking yield to state
    if(result.action === 'STAKE') {
      const yield_ = (state.totalSOL || 0.5) * 0.000015;
      state.totalSOL = (state.totalSOL || 0.5) + yield_;
    }

    // Add to history
    state.history = state.history || [];
    state.history.push({
      cycle: result.cycleNum,
      action: result.action,
      regime: result.regime.dominant,
      sanity: Math.round(result.sanity * 100),
      timestamp: new Date().toISOString()
    });
    if(state.history.length > 50) state.history = state.history.slice(-50);

    saveState(state);
    await syncToDashboard(state, result);

  } catch(e) {
    console.error('Cycle error:', e.message);
    if(manual) await send(`❌ Cycle error: ${e.message}`);
  }
}

// ── CALLBACK QUERY HANDLER (button taps) ─────────────────────────────────────
bot.on('callback_query', async (query) => {
  const data    = query.data;
  const pending = state.pendingProposal;

  await bot.answerCallbackQuery(query.id);

  if(!pending) {
    await send('No pending proposal.');
    return;
  }

  // ENTRY APPROVE
  if(data === 'approve' && pending.type === 'ENTRY') {
    const p = pending.result.proposal;

    // Fetch real current token price for accurate stop/target levels
    const { fetchTokenPrice } = require('./solos-engine');
    let entryPrice = 1.0;
    try {
      const livePrice = await fetchTokenPrice(p.mint);
      if(livePrice) entryPrice = livePrice;
    } catch(e) {}

    state.openPosition = {
      token:         p.token,
      mint:          p.mint,
      tier:          p.tier,
      entryPrice,
      entrySOL:      p.amountSOL,
      stopPrice:     entryPrice * (1 - p.stops.stopPct/100),
      targetPrice:   entryPrice * (1 + p.stops.targetPct/100),
      backstopPrice: entryPrice * (1 - p.stops.backstopPct/100),
      entryCycle:    state.cycleNum,
      entryTime:     Date.now()
    };
    state.pendingProposal = null;
    state.consecutiveWins = 0;
    saveState(state);
    await syncToDashboard(state, null);

    await send(
      `✅ *Approved*\n\n${p.amountSOL} SOL → ${p.token}\nEntry price: $${entryPrice.toFixed(6)}\nStop: $${state.openPosition.stopPrice.toFixed(6)} (-${p.stops.stopPct}%)\nTarget: $${state.openPosition.targetPrice.toFixed(6)} (+${p.stops.targetPct}%)\n\nTap to complete in MetaMask:\n${p.jupUrl}`
    );
  }

  // ENTRY SKIP
  else if(data === 'skip' && pending.type === 'ENTRY') {
    state.pendingProposal = null;
    saveState(state);
    await send(`⏭ Skipped — next cycle in 15 minutes.`);
  }

  // EXIT APPROVE
  else if(data === 'exit_approve' && pending.type === 'EXIT') {
    const pos = state.openPosition;
    const jupUrl = `https://jup.ag/swap/${pos.token}-SOL`;
    state.openPosition    = null;
    state.pendingProposal = null;
    state.consecutiveLosses = 0;
    state.recoveryMode    = false;
    saveState(state);
    await send(`✅ *Exit approved*\n\nTap to complete in MetaMask:\n${jupUrl}`);
  }

  // EXIT SKIP / HOLD
  else if(data === 'exit_skip' && pending.type === 'EXIT') {
    state.pendingProposal = null;
    saveState(state);
    await send(`⏸ Holding position. Monitoring continues.`);
  }
});

// ── COMMAND HANDLERS ──────────────────────────────────────────────────────────
bot.onText(/\/start/, async () => {
  await send(
    `👋 *SolOS Phase 4 Active*\n\nRunning cycles every 15 minutes automatically.\n\n` +
    `Commands:\n` +
    `/status — current system state\n` +
    `/run — trigger manual cycle now\n` +
    `/position — check open position\n` +
    `/pause — pause auto-cycles\n` +
    `/resume — resume auto-cycles\n` +
    `/balance — check wallet balance`
  );
});

bot.onText(/\/status/, async () => {
  const bal = WALLET_ADDR ? await fetchWalletBalance(WALLET_ADDR) : null;
  const pos = state.openPosition;
  const lines = [
    `📊 *SolOS Status*`,
    ``,
    `Cycles run: ${state.cycleNum}`,
    `Wallet: ${bal ? bal.toFixed(4)+' SOL' : 'not connected'}`,
    `Unlock level: ${state.unlockLevel}`,
    `Consecutive wins: ${state.consecutiveWins}`,
    `Consecutive losses: ${state.consecutiveLosses}`,
    `Recovery mode: ${state.recoveryMode ? 'YES' : 'no'}`,
    `Auto-cycles: ${state.paused ? 'PAUSED' : 'RUNNING'}`,
    `Open position: ${pos ? pos.token + ' (entry cycle ' + pos.entryCycle + ')' : 'none'}`
  ];
  await send(lines.join('\n'));
});

bot.onText(/\/run/, async () => {
  await send('⚡ Running manual cycle...');
  await executeCycle(true);
});

bot.onText(/\/position/, async () => {
  if(!state.openPosition) {
    await send('No open position.');
    return;
  }
  const pos = state.openPosition;
  await send(
    `📈 *Open Position*\n\nToken: ${pos.token} (Tier ${pos.tier})\nEntry cycle: ${pos.entryCycle}\nEntry SOL: ${pos.entrySOL}\nStop: -${((1-pos.stopPrice)*100).toFixed(1)}%\nTarget: +${((pos.targetPrice-1)*100).toFixed(1)}%`
  );
});

bot.onText(/\/pause/, async () => {
  state.paused = true;
  saveState(state);
  await send('⏸ Auto-cycles paused. Use /resume to restart.');
});

bot.onText(/\/resume/, async () => {
  state.paused = false;
  saveState(state);
  await send('▶️ Auto-cycles resumed. Next cycle in 15 minutes.');
});

bot.onText(/\/setup/, async () => {
  if(!JSONBIN_KEY) {
    await send('❌ JSONBIN_KEY not set in environment variables.\n\nAdd it in Render dashboard → Environment tab.');
    return;
  }
  if(JSONBIN_BIN) {
    await send(`✅ JSONBin already configured.\nBin ID: ${JSONBIN_BIN}\nDashboard reads from this bin every 30s.`);
    return;
  }
  try {
    const res = await fetch(JSONBIN_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Key': JSONBIN_KEY,
        'X-Bin-Name': 'solos-state',
        'X-Bin-Private': 'false'
      },
      body: JSON.stringify({ initialized: true, cycleNum: 0 })
    });
    const d = await res.json();
    const binId = d?.metadata?.id;
    if(binId) {
      await send(`✅ JSONBin created!\n\nBin ID: \`${binId}\`\n\nNow add to Render environment:\nJSONBIN_BIN = ${binId}\n\nThen add this to your dashboard URL as a query param or hardcode in index.html:\nhttps://api.jsonbin.io/v3/b/${binId}/latest`);
    } else {
      await send('❌ Failed to create bin: ' + JSON.stringify(d).slice(0,100));
    }
  } catch(e) {
    await send('❌ JSONBin error: ' + e.message);
  }
});

bot.onText(/\/balance/, async () => {
  if(!WALLET_ADDR) { await send('No wallet address configured.'); return; }
  const bal = await fetchWalletBalance(WALLET_ADDR);
  await send(bal ? `💰 Wallet balance: *${bal.toFixed(4)} SOL*` : '❌ Could not fetch balance.');
});

// ── CRON — every 15 minutes ───────────────────────────────────────────────────
cron.schedule('*/15 * * * *', () => {
  executeCycle(false);
});

// ── STARTUP ───────────────────────────────────────────────────────────────────
// Simple HTTP server — keeps Render alive + health check endpoint
const http = require('http');
http.createServer((req, res) => {
  if(req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running',
      cycle: state.cycleNum,
      uptime: process.uptime(),
      paused: state.paused,
      openPosition: state.openPosition ? state.openPosition.token : null
    }));
  } else {
    res.writeHead(200);
    res.end('SolOS Phase 4 running');
  }
}).listen(PORT, () => {
  console.log(`SolOS Phase 4 listening on port ${PORT}`);
  send(`🚀 *SolOS Phase 4 Started*\nCycles every 15 min · Wallet: ${WALLET_ADDR ? WALLET_ADDR.slice(0,6)+'...'+WALLET_ADDR.slice(-4) : 'not configured'}\n\nType /status for state.`);
  setTimeout(() => executeCycle(false), 5000);
});
