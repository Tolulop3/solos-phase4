'use strict';

if(global.__SOLOS_RUNNING__) { console.log('Duplicate blocked'); process.exit(0); }
global.__SOLOS_RUNNING__ = true;

process.on('uncaughtException',  e => console.log('Caught:', e.message));
process.on('unhandledRejection', e => console.log('Rejected:', e?.message || e));

const TelegramBot = require('node-telegram-bot-api');
const cron        = require('node-cron');
const fs          = require('fs');
const path        = require('path');
const http        = require('http');
const { runCycle, fetchWalletBalance } = require('./solos-engine');

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID;
const WALLET_ADDR= process.env.WALLET_ADDRESS;
const PORT       = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || '';
const JSONBIN_KEY= process.env.JSONBIN_KEY  || '';
const JSONBIN_BIN= process.env.JSONBIN_BIN  || '';
const JSONBIN_BASE = 'https://api.jsonbin.io/v3/b';

if(!BOT_TOKEN || !CHAT_ID) { console.error('Missing bot token or chat ID'); process.exit(1); }

const WEBHOOK_PATH = `/webhook/${BOT_TOKEN}`;
const bot = new TelegramBot(BOT_TOKEN, { webHook: false });

// ── REGIME CONFIG — first-class enum with explicit thresholds ─────────────────
const REGIME_CONFIG = {
  STRESS: {
    vault:1.00, opp:0.00, expl:0.00,
    label:'STRESS'
  },
  NEUTRAL_DEGRADED: {
    vault:0.92, opp:0.03, expl:0.05,
    convictionMin:68, sanityMin:72,
    stopMult:1.2, sizeMult:0.5,
    maxExplPositions:1, explCap:0.05,
    killSwitch:{ losses:2, minLossPct:1.5, cooldownHours:2 },
    persistenceCycles:2, persistenceMinutes:30,
    label:'NEUTRAL_DEGRADED'
  },
  NEUTRAL: {
    vault:0.87, opp:0.13, expl:0.00,
    convictionMin:60, sanityMin:65,
    label:'NEUTRAL'
  },
  EXPANSION: {
    vault:0.68, opp:0.22, expl:0.10,
    convictionMin:52, sanityMin:42,
    label:'EXPANSION'
  },
  EXPANSION_CONFIRMED: {
    vault:0.60, opp:0.30, expl:0.10,
    convictionMin:65, sanityMin:52,
    label:'EXPANSION_CONFIRMED'
  },
  CAUTIOUS_EXPANSION: {
    shadow:true,
    label:'CAUTIOUS_EXPANSION'
  },
  PROBE: {
    vault:0.97, opp:0.00, expl:0.03,
    sizeMult:0.25, maxPositions:1,
    stopMult:0.6,
    timeStopCycles:8,          // 2 hours max (8 × 15min)
    cooldownAfterFailHours:4,
    killOnFreshRiskOff:true,
    killOnVolSpike:true,
    // Entry conditions
    confidenceMin:88, tradabilityMin:82, fragilityMax:8,
    persistenceMinutes:120,    // 2 hours signal persistence
    signalAgeMin:6,            // stale RISK_OFF only
    probeWinRateMin:40,        // auto-suspend if below 40% after 20 trades
    label:'PROBE'
  }
};

// ── STATE ─────────────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'state.json');
function loadState() {
  try { if(fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); } catch(e) {}
  return {
    cycleNum:0, totalSOL:0.5, startSOL:0.5,
    consecutiveWins:0, consecutiveLosses:0,
    recoveryMode:false, unlockLevel:2,
    openPosition:null, history:[], pendingProposal:null,
    paused:false, _cycleRunning:false,
    tradeLog:[], winRate:null,
    // Persistence tracking for NEUTRAL_DEGRADED exploration
    explorationSignalSeen:0,      // cycle count of consecutive signal
    explorationSignalTime:null,   // timestamp first seen
    // Kill switch state
    explorationKillSwitch:false,
    explorationKillUntil:null,
    explorationLossCount:0,
    explorationLossPct:0,
    // Probe mode tracking
    probePersistenceStart:null,
    probeCooldownUntil:null,
    probeFailCount:0,
    probeSuspended:false,
    // Vol warmup
    volCycleCount:0,
    // Shadow tracking
    shadowTrades:[]
  };
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s,null,2)); }
  catch(e) { console.error('Save failed:',e.message); }
}
let state = loadState();

// ── INVESTOS BRIDGE ───────────────────────────────────────────────────────────
const INVESTOS_URL = 'https://tolulop3.github.io/investos/latest_brief.json';

// Style compatibility — token types mapped to trade styles
const TOKEN_STYLES = {
  JTO:  ['defensive','pullback','low_vol','momentum'],
  BONK: ['momentum','high_beta','breakout'],
  WIF:  ['momentum','high_beta','breakout'],
  PYTH: ['pullback','low_vol','defensive'],
  RAY:  ['pullback','momentum','mean_reversion']
};

const DEFAULT_STYLES_BY_REGIME = {
  BULL:     ['breakout','momentum','high_beta','pullback','defensive'],
  NORMAL:   ['momentum','pullback','mean_reversion','defensive'],
  CAUTIOUS: ['pullback','defensive','low_vol','mean_reversion'],
  RISK_OFF: [],
  BEAR:     []
};

async function fetchInvestOSMacro() {
  try {
    const r = await fetch(INVESTOS_URL, { signal:AbortSignal.timeout(6000) });
    if(!r.ok) return null;
    const b = await r.json();
    const generatedAt = b.generated_at ? new Date(b.generated_at) : null;
    const ageHours = generatedAt ? (Date.now()-generatedAt.getTime())/3600000 : 999;
    const macroRegime = b.macro?.regime || 'NORMAL';
    const allowedStyles = b.allowed_styles || b.macro?.allowed_styles ||
      DEFAULT_STYLES_BY_REGIME[macroRegime] || DEFAULT_STYLES_BY_REGIME['NORMAL'];
    const blockedStyles = b.blocked_styles || b.macro?.blocked_styles || [];
    const health  = b.health || b.macro?.health || 'NORMAL';
    const exposure = b.exposure || b.macro?.exposure || 1.0;
    const m = {
      macroRegime,
      marketRegime:  b.market_regime?.regime || 'BULL',
      solConviction: b.crypto?.assets?.['SOL-USD']?.conviction || 0,
      solDirection:  b.crypto?.assets?.['SOL-USD']?.direction || 'NEUTRAL',
      btcConviction: b.crypto?.assets?.['BTC-USD']?.conviction || 0,
      btcDirection:  b.crypto?.assets?.['BTC-USD']?.direction || 'NEUTRAL',
      timestamp:     b.generated_at || null,
      ageHours:      +ageHours.toFixed(1),
      fresh:         ageHours <= 8,
      allowedStyles, blockedStyles, health, exposure
    };
    console.log(`InvestOS: macro=${m.macroRegime} health=${m.health} exposure=${m.exposure} styles=[${m.allowedStyles.join(',')||'none'}] SOL=${m.solDirection}@${m.solConviction}% age=${m.ageHours}h`);
    return m;
  } catch(e) { console.log('InvestOS unavailable'); return null; }
}

// ── REGIME OVERRIDE — clean hierarchy ─────────────────────────────────────────
function applyInvestOSOverride(localRegime, inv, scores) {
  if(!inv) return { regime:localRegime, source:'local', note:'InvestOS unavailable',
    allowedStyles:DEFAULT_STYLES_BY_REGIME['NORMAL'], health:'NORMAL', exposure:1.0 };

  if(!inv.fresh) console.log(`InvestOS signal stale (${inv.ageHours}h) — applying conservatively`);

  // DEGRADED health — apply size penalty across all regimes
  const healthMult = inv.health==='DEGRADED' ? 0.6 : inv.health==='CRITICAL' ? 0.3 : 1.0;

  // HARD LOCK — fresh RISK_OFF or bear market
  if(inv.marketRegime==='BEAR')
    return { regime:'STRESS', source:'investos',
      note:`Market BEAR — vault only`,
      allowedStyles:[], health:inv.health, exposure:0 };

  if(inv.macroRegime==='RISK_OFF') {
    // Check PROBE eligibility — stale signal + extremely strong local conditions
    const cfg = REGIME_CONFIG.PROBE;
    const probeEligible =
      inv.ageHours >= cfg.signalAgeMin &&
      localRegime === 'EXPANSION' &&
      scores && scores.confidence >= cfg.confidenceMin &&
      scores.tradability >= cfg.tradabilityMin &&
      scores.fragility <= cfg.fragilityMax &&
      !state.probeSuspended &&
      (!state.probeCooldownUntil || Date.now() > state.probeCooldownUntil);

    if(probeEligible) {
      // Check persistence — conditions must have been met for 2+ hours
      const now = Date.now();
      if(!state.probePersistenceStart) {
        state.probePersistenceStart = now;
        return { regime:'STRESS', source:'investos',
          note:`RISK_OFF · Probe conditions met — building persistence (0/${cfg.persistenceMinutes}min)` };
      }
      const persistMins = (now - state.probePersistenceStart) / 60000;
      if(persistMins < cfg.persistenceMinutes) {
        return { regime:'STRESS', source:'investos',
          note:`RISK_OFF · Probe persistence: ${Math.round(persistMins)}/${cfg.persistenceMinutes}min` };
      }
      // All conditions met — PROBE mode
      return { regime:'PROBE', source:'solos_probe',
        note:`Stale RISK\\_OFF (${inv.ageHours}h) · Probing carefully · 25% size · 2h time stop` };
    }

    // Reset persistence if conditions not met
    if(state.probePersistenceStart) state.probePersistenceStart = null;
    return { regime:'STRESS', source:'investos',
      note:`Macro RISK\\_OFF / Market ${inv.marketRegime} — vault only` };
  }

  // CAUTIOUS macro handling — map to NEUTRAL_DEGRADED not STRESS
  if(inv.macroRegime==='CAUTIOUS') {
    // Check if strong enough for CAUTIOUS_EXPANSION shadow
    if(localRegime==='EXPANSION' &&
       inv.solConviction>=70 && inv.solDirection==='LONG' &&
       inv.btcDirection==='LONG' && inv.btcConviction>=60 &&
       scores && scores.confidence>=80 && scores.tradability>=75 && scores.fragility<=15) {
      // Log shadow trade but don't execute
      return { regime:'NEUTRAL_DEGRADED', source:'investos',
        note:`Macro CAUTIOUS · CAUTIOUS\\_EXPANSION candidate (shadow only)`,
        shadowCandidate:true };
    }
    // Standard CAUTIOUS → NEUTRAL_DEGRADED (not STRESS, not plain NEUTRAL)
    return { regime:'NEUTRAL_DEGRADED', source:'investos',
      note:`Macro CAUTIOUS → NEUTRAL\\_DEGRADED · elevated thresholds active` };
  }

  // BULL macro — can confirm expansion
  if(localRegime==='EXPANSION' &&
     inv.macroRegime==='BULL' &&
     inv.solConviction>=65 && inv.solDirection==='LONG' && inv.fresh)
    return { regime:'EXPANSION_CONFIRMED', source:'investos',
      note:`Macro BULL confirmed · SOL ${inv.solConviction}% · fresh signal`,
      allowedStyles: inv.allowedStyles.length ? inv.allowedStyles : DEFAULT_STYLES_BY_REGIME['BULL'],
      health:inv.health, exposure:Math.min(1.0, inv.exposure*healthMult) };

  // NORMAL macro with local expansion — standard expansion
  if(inv.macroRegime==='BULL' || inv.macroRegime==='NORMAL')
    return { regime:localRegime, source:'local',
      note:`No conflict · macro=${inv.macroRegime}`,
      allowedStyles: inv.allowedStyles.length ? inv.allowedStyles : DEFAULT_STYLES_BY_REGIME[inv.macroRegime]||DEFAULT_STYLES_BY_REGIME['NORMAL'],
      health:inv.health, exposure:Math.min(1.0, inv.exposure*healthMult) };

  return { regime:localRegime, source:'local', note:`Fallback · macro=${inv.macroRegime}`,
    allowedStyles:inv.allowedStyles||DEFAULT_STYLES_BY_REGIME['NORMAL'],
    health:inv.health, exposure:inv.exposure*healthMult };
}

// ── PROBE MODE GUARD ──────────────────────────────────────────────────────────
function checkProbeInvalidation(inv, scores, result) {
  if(!state.openPosition?.probeMode) return false;
  const cfg = REGIME_CONFIG.PROBE;

  // Kill immediately if InvestOS refreshes with fresh RISK_OFF
  if(cfg.killOnFreshRiskOff && inv?.macroRegime==='RISK_OFF' && inv?.fresh) {
    console.log('PROBE invalidated: fresh RISK_OFF signal');
    return { kill:true, reason:'Fresh RISK_OFF confirmed — probe invalidated' };
  }
  // Kill on vol spike
  if(cfg.killOnVolSpike && result?.marketData?.volatility > 0.75) {
    return { kill:true, reason:`Vol spike ${(result.marketData.volatility*100).toFixed(0)}% — probe exit` };
  }
  // Time stop
  const cyclesHeld = (state.cycleNum||0) - (state.openPosition.entryCycle||0);
  if(cyclesHeld >= cfg.timeStopCycles) {
    return { kill:true, reason:`Probe time stop: ${cyclesHeld} cycles (max ${cfg.timeStopCycles})` };
  }
  return false;
}

function recordProbeLoss(lossPct) {
  state.probeFailCount = (state.probeFailCount||0) + 1;
  state.probeCooldownUntil = Date.now() + REGIME_CONFIG.PROBE.cooldownAfterFailHours*3600000;
  state.probePersistenceStart = null;

  // Auto-suspend if win rate below threshold after 20 probe trades
  const probeTradesClosed = (state.tradeLog||[]).filter(t=>t.probeMode&&t.outcome!==null);
  if(probeTradesClosed.length >= 20) {
    const probeWins = probeTradesClosed.filter(t=>t.outcome==='WIN').length;
    const probeWinRate = Math.round(probeWins/probeTradesClosed.length*100);
    if(probeWinRate < REGIME_CONFIG.PROBE.probeWinRateMin) {
      state.probeSuspended = true;
      console.log(`PROBE auto-suspended: win rate ${probeWinRate}% below ${REGIME_CONFIG.PROBE.probeWinRateMin}% threshold`);
      return true; // suspended
    }
  }
  return false;
}

// ── NEUTRAL_DEGRADED EXPLORATION GUARD ────────────────────────────────────────
function checkExplorationEligible(inv, scores) {
  // Kill switch active?
  if(state.explorationKillSwitch) {
    if(state.explorationKillUntil && Date.now() < state.explorationKillUntil) {
      const hoursLeft = ((state.explorationKillUntil-Date.now())/3600000).toFixed(1);
      return { eligible:false, reason:`Kill switch active — ${hoursLeft}h remaining` };
    }
    // Cooldown expired — reset
    state.explorationKillSwitch = false;
    state.explorationLossCount = 0;
    state.explorationLossPct = 0;
    state.explorationKillUntil = null;
  }

  // Max concurrent positions
  if(state.openPosition) {
    return { eligible:false, reason:'Exploration position already open' };
  }

  if(!inv) return { eligible:false, reason:'InvestOS unavailable' };

  // Conviction threshold (stricter than NEUTRAL)
  if(inv.solConviction < 68)
    return { eligible:false, reason:`SOL conviction ${inv.solConviction}% below 68% threshold` };

  // Sanity threshold
  if(!scores || scores.sanity < 0.72)
    return { eligible:false, reason:`Sanity ${scores?Math.round(scores.sanity*100):'?'} below 72 threshold` };

  // Whale proxy (volume trend positive — Phase 7 will replace with real whale data)
  const volumeOk = scores.tradability >= 0.70;
  if(!volumeOk)
    return { eligible:false, reason:`Volume proxy (tradability ${Math.round(scores.tradability*100)}) insufficient`, whaleProxy:true };

  // Persistence guard — signal must appear in 2+ consecutive cycles OR 30+ minutes
  const now = Date.now();
  const persistMinutes = state.explorationSignalTime
    ? (now - state.explorationSignalTime) / 60000 : 0;

  if(state.explorationSignalSeen < 2 && persistMinutes < 30) {
    // Update counter
    state.explorationSignalSeen = (state.explorationSignalSeen||0) + 1;
    if(!state.explorationSignalTime) state.explorationSignalTime = now;
    return { eligible:false,
      reason:`Persistence guard: ${state.explorationSignalSeen}/2 cycles, ${persistMinutes.toFixed(0)}min/${30}min` };
  }

  return { eligible:true, reason:`Exploration eligible · conviction ${inv.solConviction}% · vol proxy ok · persistence confirmed`, whaleProxy:true };
}

function resetExplorationPersistence() {
  state.explorationSignalSeen = 0;
  state.explorationSignalTime = null;
}

function recordExplorationLoss(lossPct) {
  state.explorationLossCount = (state.explorationLossCount||0) + 1;
  state.explorationLossPct = (state.explorationLossPct||0) + Math.abs(lossPct);
  const cfg = REGIME_CONFIG.NEUTRAL_DEGRADED.killSwitch;
  if(state.explorationLossCount >= cfg.losses && state.explorationLossPct >= cfg.minLossPct) {
    state.explorationKillSwitch = true;
    state.explorationKillUntil = Date.now() + cfg.cooldownHours*3600000;
    console.log(`Exploration kill switch activated — ${cfg.cooldownHours}h cooldown`);
    return true;
  }
  return false;
}

// ── WIN RATE TRACKER ──────────────────────────────────────────────────────────
function logTrade(entry) {
  state.tradeLog = state.tradeLog || [];
  state.tradeLog.push({ ...entry, id:`t_${Date.now()}`, timestamp:new Date().toISOString() });
  if(state.tradeLog.length>500) state.tradeLog=state.tradeLog.slice(-500);
  recalcWinRate();
}

function recalcWinRate() {
  const closed=(state.tradeLog||[]).filter(t=>t.outcome!==null&&!t.shadowTrade);
  if(!closed.length){state.winRate=null;return;}
  const wins=closed.filter(t=>t.outcome==='WIN');
  const losses=closed.filter(t=>t.outcome==='LOSS');
  const avgWin=wins.length?wins.reduce((a,t)=>a+(t.pnlPct||0),0)/wins.length:0;
  const avgLoss=losses.length?Math.abs(losses.reduce((a,t)=>a+(t.pnlPct||0),0)/losses.length):0;
  const winRate=wins.length/closed.length;
  const expectancy=(winRate*avgWin)-((1-winRate)*avgLoss);
  state.winRate={
    total:closed.length, wins:wins.length, losses:losses.length,
    rate:Math.round(winRate*100),
    avgWin:+avgWin.toFixed(2), avgLoss:+avgLoss.toFixed(2),
    expectancy:+expectancy.toFixed(3),
    insufficient: closed.length < 20
  };
}

// ── JSONBIN SYNC ──────────────────────────────────────────────────────────────
async function syncToDashboard(lastResult, investos, override) {
  if(!JSONBIN_KEY||!JSONBIN_BIN) return;
  try {
    const payload = {
      cycleNum:state.cycleNum, totalSOL:state.totalSOL,
      unlockLevel:state.unlockLevel, consecutiveWins:state.consecutiveWins,
      consecutiveLosses:state.consecutiveLosses, recoveryMode:state.recoveryMode,
      openPosition:state.openPosition, paused:state.paused,
      lastUpdated:new Date().toISOString(),
      lastAction:lastResult?.action||null,
      lastRegime:override?.regime||lastResult?.regime?.dominant||null,
      lastSanity:lastResult?Math.round(lastResult.sanity*100):null,
      lastExpProb:lastResult?Math.round(lastResult.regime?.expProb*100):null,
      lastConfidence:lastResult?Math.round(lastResult.regime?.confidence*100):null,
      lastTradability:lastResult?Math.round(lastResult.scores?.tradability*100):null,
      lastFragility:lastResult?Math.round(lastResult.scores?.fragility*100):null,
      lastExecQuality:lastResult?Math.round(lastResult.scores?.execQuality*100):null,
      lastAggression:lastResult?.scores?.aggressionMult||null,
      walletBalance:lastResult?.walletBalance||null, solPrice:lastResult?.solPrice||null,
      dataSource:lastResult?.marketData?.source||null,
      recentHistory:state.history?.slice(-10)||[], winRate:state.winRate||null,
      explorationKillSwitch:state.explorationKillSwitch,
      volState:state.volCycleCount<10?'warming':'stable',
      investos:investos?{
        macroRegime:investos.macroRegime, marketRegime:investos.marketRegime,
        solConviction:investos.solConviction, solDirection:investos.solDirection,
        ageHours:investos.ageHours, fresh:investos.fresh, timestamp:investos.timestamp
      }:null,
      overrideNote:override?.note||null
    };
    const res=await fetch(`${JSONBIN_BASE}/${JSONBIN_BIN}`,{
      method:'PUT', headers:{'Content-Type':'application/json','X-Master-Key':JSONBIN_KEY},
      body:JSON.stringify(payload)
    });
    console.log('JSONBin sync:',res.status);
  } catch(e){console.log('JSONBin failed:',e.message);}
}

// ── FORMATTERS ────────────────────────────────────────────────────────────────
function regimeEmoji(r){
  if(r==='EXPANSION'||r==='EXPANSION_CONFIRMED') return '🟢';
  if(r==='STRESS') return '🔴';
  if(r==='NEUTRAL_DEGRADED') return '🟠';
  if(r==='PROBE') return '🔬';
  return '🟡';
}

function escapeMarkdown(text) {
  return (text||'').replace(/_/g,'\\_').replace(/\*/g,'\\*').replace(/\[/g,'\\[');
}

function formatCycleAlert(result,inv,override) {
  const r=result.regime,s=result.scores;
  const cfg=REGIME_CONFIG[override?.regime]||{};
  return [
    `⚡ *SolOS Cycle ${result.cycleNum}*`,``,
    `${regimeEmoji(override?.regime||r.dominant)} Regime: *${override?.regime||r.dominant}*`,
    `📊 Confidence: ${Math.round(r.confidence*100)} | Sanity: ${Math.round(result.sanity*100)}`,
    `💧 Tradability: ${Math.round(s.tradability*100)} | Fragility: ${Math.round(s.fragility*100)}`,
    inv?`🌍 Macro: ${inv.macroRegime} · ${inv.health!=='NORMAL'?'⚠️ '+inv.health+' ':''}SOL ${inv.solDirection} ${inv.solConviction}% · ${inv.fresh?'fresh':'⚠️ stale '+inv.ageHours+'h'}`:`🌍 Macro: unavailable`,
    override?.allowedStyles?.length?`📋 Allowed styles: ${override.allowedStyles.slice(0,3).join(', ')}${override.allowedStyles.length>3?'...':''}`:'',
    override?.source==='investos'?`⚡ ${escapeMarkdown(override.note)}`:'',
    state.explorationKillSwitch?`🚫 Exploration kill switch active`:'',
    state.volCycleCount<10?`⏳ Vol warming (${state.volCycleCount}/10 cycles)`:'',
    `💰 Wallet: ${result.walletBalance?result.walletBalance.toFixed(4)+' SOL':'not connected'}`,``,
    `Status: *${result.action}*`
  ].filter(Boolean).join('\n');
}

function formatTradeProposal(result,inv,override,explCheck) {
  const p=result.proposal;
  const cfg=REGIME_CONFIG[override?.regime]||{};
  return [
    `🚀 *TRADE PROPOSED — Cycle ${result.cycleNum}*`,``,
    `SOL → *${p.token}* (Tier ${p.tier})`,
    `Amount: *${p.amountSOL} SOL*`,``,
    `📉 Stop: -${p.stops.stopPct}% (${cfg.stopMult?cfg.stopMult+'× vol':'std'})`,
    `📈 Target: +${p.stops.targetPct}%`,
    `🛡 Backstop: -${p.stops.backstopPct}%`,``,
    `Regime: ${Math.round(result.regime.expProb*100)}% expansion | Sanity: ${Math.round(result.sanity*100)}/100`,
    inv?`🌍 Macro: ${inv.macroRegime} · SOL ${inv.solConviction}%`:'',
    override?.regime==='EXPANSION_CONFIRMED'?'✅ InvestOS CONFIRMED':'',
    override?.regime==='NEUTRAL_DEGRADED'?`🟠 DEGRADED MODE · ${cfg.sizeMult}× size · tighter stops`:'',    explCheck?.whaleProxy?`🐋 Whale: volume proxy (real data Phase 7)`:'',
    `Signal: ${p.dataSource==='live'?'🟢 live':'🟡 simulated'}`,``,
    `Tap ✅ to approve or ❌ to skip`
  ].filter(Boolean).join('\n');
}

function formatPositionAlert(pos,update) {
  const e=update.action==='TARGET'?'✅':update.action==='BACKSTOP'?'🚨':'⚠️';
  return [`${e} *${update.action} — ${pos.token}*`,``,
    `P&L: *${update.pnlPct>=0?'+':''}${update.pnlPct.toFixed(1)}%*`,
    `Entry: ${pos.entryPrice.toFixed(4)} | Now: ${update.currentPrice.toFixed(4)}`,
    `Cycles held: ${update.cyclesHeld}`,``,`Tap ✅ to exit or ❌ to hold`].join('\n');
}

// ── SEND ──────────────────────────────────────────────────────────────────────
async function send(text,opts={}) {
  try { await bot.sendMessage(CHAT_ID,text,{parse_mode:'Markdown',...opts}); }
  catch(e){console.error('Send failed:',e.message);}
}

const APPROVE_KB={inline_keyboard:[[{text:'✅ Approve',callback_data:'approve'},{text:'❌ Skip',callback_data:'skip'}]]};
const EXIT_KB={inline_keyboard:[[{text:'✅ Exit now',callback_data:'exit_approve'},{text:'❌ Hold',callback_data:'exit_skip'}]]};

// ── MAIN CYCLE ────────────────────────────────────────────────────────────────
async function executeCycle(manual=false) {
  if(state.paused&&!manual) return;
  if(state._cycleRunning){console.log('Already running — skipped');return;}
  state._cycleRunning=true;
  console.log(`Running cycle ${(state.cycleNum||0)+1}...`);

  try {
    // Fetch InvestOS macro
    const investos = await fetchInvestOSMacro();

    // Run engine
    const result = await runCycle(state, WALLET_ADDR);
    state.cycleNum = result.cycleNum;
    state.volCycleCount = Math.min((state.volCycleCount||0)+1, 20);

    // Apply regime override with scores for CAUTIOUS_EXPANSION shadow check
    const scores = {
      ...result.scores,
      confidence: result.regime.confidence,
      sanity: result.sanity
    };
    const override = applyInvestOSOverride(result.regime.dominant, investos, scores);
    const finalRegime = override.regime;

    // Shadow candidate logging
    if(override.shadowCandidate) {
      state.shadowTrades = state.shadowTrades||[];
      state.shadowTrades.push({
        cycle:state.cycleNum, regime:'CAUTIOUS_EXPANSION',
        shadowTrade:true, wouldExecute:true,
        solConviction:investos?.solConviction, sanity:Math.round(result.sanity*100),
        timestamp:new Date().toISOString(), outcome:null, entryPrice:null
      });
      console.log('Shadow candidate logged: CAUTIOUS_EXPANSION');
    }

    // Reset persistence if signal not present
    const expansionSignalPresent = finalRegime==='NEUTRAL_DEGRADED' &&
      investos?.solConviction>=68 && investos?.solDirection==='LONG';
    if(!expansionSignalPresent) resetExplorationPersistence();

    // Check if trade should be blocked
    let blocked = false;
    let blockReason = '';
    let explCheck = null;

    if(result.action==='TRADE_PROPOSED') {
      // STYLE FILTER — check if proposed token is allowed in current regime
      const proposedToken = result.proposal?.token;
      const tokenStyles = TOKEN_STYLES[proposedToken] || ['momentum'];
      const allowedStyles = override?.allowedStyles || [];
      const blockedStyles = investos?.blockedStyles || [];

      const styleAllowed = allowedStyles.length === 0
        ? false  // empty allowed = nothing allowed (RISK_OFF)
        : tokenStyles.some(s => allowedStyles.includes(s));
      const styleBlocked = blockedStyles.length > 0 &&
        tokenStyles.every(s => blockedStyles.includes(s));

      if(styleBlocked || !styleAllowed) {
        // Try to find a better-fit token from allowed styles
        const betterToken = Object.entries(TOKEN_STYLES).find(([tok, styles]) =>
          tok !== proposedToken &&
          styles.some(s => allowedStyles.includes(s))
        );
        if(betterToken && result.proposal) {
          const [newTok] = betterToken;
          console.log(`Style redirect: ${proposedToken} → ${newTok} (${allowedStyles.join(',')} allowed)`);
          result.proposal.token = newTok;
          result.proposal.mint = (REGIME_CONFIG.PROBE ? TIER1_TOKENS?.[newTok] : null) ||
            require('./solos-engine').TIER1_TOKENS?.[newTok] || result.proposal.mint;
          result.proposal.jupUrl = `https://jup.ag/swap/SOL-${newTok}`;
        } else {
          blocked = true;
          blockReason = `Token ${proposedToken} style [${tokenStyles.join(',')}] not in allowed [${allowedStyles.join(',')||'none'}]`;
        }
      }

      // Apply exposure scaling from InvestOS health
      if(!blocked && result.proposal && override?.exposure !== undefined) {
        const exposureScale = Math.min(1.0, override.exposure);
        if(exposureScale < 1.0) {
          result.proposal.amountSOL = +(result.proposal.amountSOL * exposureScale).toFixed(4);
          console.log(`Exposure scaled to ${(exposureScale*100).toFixed(0)}% — health: ${investos?.health}`);
        }
      }

      if(!blocked) {
        if(finalRegime==='STRESS') {
          blocked=true; blockReason='STRESS regime — vault only';
        } else if(finalRegime==='NEUTRAL_DEGRADED') {
          explCheck = checkExplorationEligible(investos, scores);
          if(!explCheck.eligible) { blocked=true; blockReason=explCheck.reason; }
        } else if(finalRegime==='NEUTRAL') {
          blocked=true; blockReason='NEUTRAL regime — no exploration';
        }
      }
    }

    if(blocked) {
      result.action='BLOCKED'; result.blockReason=blockReason;
      console.log('Trade blocked:',blockReason);
    }

    // Check probe invalidation if open position is a probe trade
    if(state.openPosition?.probeMode) {
      const probeInvalid = checkProbeInvalidation(investos, scores, result);
      if(probeInvalid?.kill) {
        // Force exit signal
        result.action = 'EXIT_NEEDED';
        result.exitReason = 'PROBE_INVALIDATED';
        result.positionUpdate = {
          action:'PROBE_INVALIDATED', pnlPct:0,
          currentPrice:state.openPosition.entryPrice,
          cyclesHeld:(state.cycleNum||0)-(state.openPosition.entryCycle||0),
          cyclesLeft:0, reason:probeInvalid.reason
        };
        await send(`🔬 *PROBE INVALIDATED*\n${probeInvalid.reason}\nExiting position.`);
      }
    }

    // Handle exits
    if(result.positionUpdate&&result.action==='EXIT_NEEDED') {
      state.pendingProposal={type:'EXIT',result,investos,override};
      saveState(state);
      await send(formatPositionAlert(state.openPosition,result.positionUpdate),{reply_markup:EXIT_KB});
      await syncToDashboard(result,investos,override);
      return;
    }

    // Handle trade proposal
    if(result.action==='TRADE_PROPOSED') {
      const cfg = REGIME_CONFIG[finalRegime]||{};
      // Apply regime-specific sizing
      if(cfg.sizeMult && result.proposal) {
        result.proposal.amountSOL = +(result.proposal.amountSOL*cfg.sizeMult).toFixed(4);
      }
      const isProbe = finalRegime==='PROBE';
      state.pendingProposal={type:'ENTRY',result,investos,override,explCheck,isProbe};
      logTrade({
        cycle:state.cycleNum, entryRegime:finalRegime,
        investosRegime:investos?.macroRegime||null,
        solConviction:investos?.solConviction||null,
        signalType:finalRegime, action:'PROPOSED',
        token:result.proposal.token, amountSOL:result.proposal.amountSOL,
        approved:null, outcome:null, exitReason:null, pnlPct:null,
        shadowTrade:false, probeMode:isProbe,
        whaleProxy:explCheck?.whaleProxy||false
      });
      saveState(state);
      await send(formatTradeProposal(result,investos,override,explCheck),{reply_markup:APPROVE_KB});
      await syncToDashboard(result,investos,override);
      return;
    }

    // Emergency
    if(result.action==='EMERGENCY') {
      await send(`🚨 *EMERGENCY — Cycle ${result.cycleNum}*\nVolatility spike. Vault only.`);
      if(state.openPosition){state.openPosition=null;}
      saveState(state);
      await syncToDashboard(result,investos,override);
      return;
    }

    // Notify every cycle when blocked or regime changes, every 4th when staking
    const regimeChanged = state.history.length >= 2 &&
      state.history[state.history.length-1]?.regime !== (state.history[state.history.length-2]?.regime);
    if(manual || result.action === 'BLOCKED' || regimeChanged || result.cycleNum % 4 === 0) {
      await send(formatCycleAlert(result,investos,override));
    }

    if(result.action==='STAKE') state.totalSOL=(state.totalSOL||0.5)+(state.totalSOL||0.5)*0.000015;

    state.history=state.history||[];
    state.history.push({
      cycle:result.cycleNum, action:result.action, regime:finalRegime,
      sanity:Math.round(result.sanity*100), investosMacro:investos?.macroRegime||null,
      volState:state.volCycleCount<10?'warming':'stable',
      timestamp:new Date().toISOString()
    });
    if(state.history.length>50) state.history=state.history.slice(-50);

    saveState(state);
    await syncToDashboard(result,investos,override);

  } catch(e) {
    console.error('Cycle error:',e.message);
    if(manual) await send(`❌ Cycle error: ${e.message}`);
  } finally { state._cycleRunning=false; }
}

// ── CALLBACKS ─────────────────────────────────────────────────────────────────
bot.on('callback_query', async(query)=>{
  const data=query.data, pending=state.pendingProposal;
  await bot.answerCallbackQuery(query.id);
  if(!pending){await send('No pending proposal.');return;}

  if(data==='approve'&&pending.type==='ENTRY') {
    const p=pending.result.proposal;
    const {fetchTokenPrice}=require('./solos-engine');
    let entryPrice=1.0;
    try{const lp=await fetchTokenPrice(p.mint);if(lp)entryPrice=lp;}catch(e){}
    const cfg=REGIME_CONFIG[pending.override?.regime]||{};
    const stopMult=cfg.stopMult||1.5;
    state.openPosition={
      token:p.token, mint:p.mint, tier:p.tier, entryPrice, entrySOL:p.amountSOL,
      stopPrice:     entryPrice*(1-p.stops.stopPct/100),
      targetPrice:   entryPrice*(1+p.stops.targetPct/100),
      backstopPrice: entryPrice*(1-p.stops.backstopPct/100),
      entryCycle:state.cycleNum, entryTime:Date.now(),
      regime:pending.override?.regime||'UNKNOWN',
      stopMult, explorationTrade: pending.override?.regime==='NEUTRAL_DEGRADED'
    };
    const li=(state.tradeLog||[]).findLastIndex(t=>t.cycle===state.cycleNum&&t.action==='PROPOSED');
    if(li>=0){state.tradeLog[li].approved=true;state.tradeLog[li].entryPrice=entryPrice;}
    state.pendingProposal=null;
    saveState(state);
    await syncToDashboard(null,null,null);
    await send(`✅ *Approved*\n\n${p.amountSOL} SOL → ${p.token}\nEntry: $${entryPrice.toFixed(6)}\nStop: $${state.openPosition.stopPrice.toFixed(6)} (-${p.stops.stopPct}%)\nTarget: $${state.openPosition.targetPrice.toFixed(6)} (+${p.stops.targetPct}%)\n\n${p.jupUrl}`);
  }
  else if(data==='skip'&&pending.type==='ENTRY') {
    const li=(state.tradeLog||[]).findLastIndex(t=>t.cycle===state.cycleNum&&t.action==='PROPOSED');
    if(li>=0) state.tradeLog[li].approved=false;
    state.pendingProposal=null;
    saveState(state);
    await send(`⏭ Skipped — next cycle in 15 min.`);
  }
  else if(data==='exit_approve'&&pending.type==='EXIT') {
    const pos=state.openPosition;
    const pnl=pending.result.positionUpdate?.pnlPct||0;
    const li=(state.tradeLog||[]).findLastIndex(t=>t.token===pos?.token&&t.approved===true);
    if(li>=0){
      state.tradeLog[li].outcome=pnl>=0?'WIN':'LOSS';
      state.tradeLog[li].exitReason=pending.result.positionUpdate?.action;
      state.tradeLog[li].pnlPct=pnl;
      recalcWinRate();
      // Probe loss recording
      if(pos?.probeMode && pnl<0) {
        const suspended = recordProbeLoss(Math.abs(pnl));
        if(suspended) await send(`🔬 *PROBE mode auto-suspended*\nWin rate below ${REGIME_CONFIG.PROBE.probeWinRateMin}% threshold after 20 trades.\nReview /winrate before re-enabling.`);
        else await send(`🔬 Probe loss recorded · ${REGIME_CONFIG.PROBE.cooldownAfterFailHours}h cooldown active`);
      }
      // Exploration kill switch
      if(pos?.explorationTrade && pnl<0) {
        const triggered=recordExplorationLoss(Math.abs(pnl));
        if(triggered) await send(`🚫 *Exploration kill switch activated*\n2 losses ≥1.5% · 2 hour cooldown`);
      }
    }
    state.openPosition=null; state.pendingProposal=null;
    state.consecutiveLosses=0; state.recoveryMode=false;
    saveState(state);
    await send(`✅ *Exit approved*\n\nhttps://jup.ag/swap/${pos?.token}-SOL\nP&L: ${pnl>=0?'+':''}${pnl.toFixed(2)}%`);
  }
  else if(data==='exit_skip'&&pending.type==='EXIT') {
    state.pendingProposal=null; saveState(state);
    await send(`⏸ Holding. Monitoring continues.`);
  }
});

// ── COMMANDS ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/,async()=>await send(
  `👋 *SolOS + InvestOS Bridge*\n\nRegimes: STRESS / NEUTRAL_DEGRADED / NEUTRAL / EXPANSION / EXPANSION_CONFIRMED\n\n/status /run /position /winrate /shadowreport /pause /resume /balance /setup`
));

bot.onText(/\/status/,async()=>{
  const bal=WALLET_ADDR?await fetchWalletBalance(WALLET_ADDR):null;
  const inv=await fetchInvestOSMacro();
  const pos=state.openPosition;
  const wr=state.winRate;
  await send([`📊 *SolOS Status*`,``,
    `Cycles: ${state.cycleNum} | Vol: ${state.volCycleCount<10?'warming ('+state.volCycleCount+'/10)':'stable'}`,
    `Wallet: ${bal?bal.toFixed(4)+' SOL':'n/a'}`,
    `Open position: ${pos?pos.token+' ('+pos.regime+')':'none'}`,
    `Recovery: ${state.recoveryMode?'YES':'no'} | Auto: ${state.paused?'PAUSED':'RUNNING'}`,
    `Exploration kill: ${state.explorationKillSwitch?'ACTIVE':'off'} | Probe: ${state.probeSuspended?'SUSPENDED':state.probeCooldownUntil&&Date.now()<state.probeCooldownUntil?'cooldown':'ready'}`,
    `Win rate: ${wr?wr.rate+'% · expectancy '+wr.expectancy+' ('+wr.total+' trades)':'no data yet'}`,``,
    `🌍 InvestOS: ${inv?.macroRegime||'unavailable'} · ${inv?.fresh?'fresh':'stale '+inv?.ageHours+'h'}`,
    `SOL: ${inv?.solDirection||'—'} ${inv?.solConviction||0}% | BTC: ${inv?.btcDirection||'—'} ${inv?.btcConviction||0}%`
  ].join('\n'));
});

bot.onText(/\/run/,async()=>{await send('⚡ Running manual cycle...');await executeCycle(true);});

bot.onText(/\/winrate/,async()=>{
  const wr=state.winRate;
  if(!wr){await send('No closed trades yet. Min 20 needed for reliable stats.');return;}
  const byRegime={};
  (state.tradeLog||[]).filter(t=>t.outcome&&!t.shadowTrade).forEach(t=>{
    const k=t.entryRegime||'UNKNOWN';
    byRegime[k]=byRegime[k]||{wins:0,losses:0,pnl:[]};
    if(t.outcome==='WIN')byRegime[k].wins++;else byRegime[k].losses++;
    byRegime[k].pnl.push(t.pnlPct||0);
  });
  const lines=Object.entries(byRegime).map(([r,v])=>{
    const total=v.wins+v.losses;
    const avgPnl=v.pnl.reduce((a,b)=>a+b,0)/v.pnl.length;
    return `  ${r}: ${Math.round(v.wins/total*100)}% (${total} trades · avg ${avgPnl>=0?'+':''}${avgPnl.toFixed(1)}%)`;
  });
  await send([`📈 *Win Rate Report*`,``,
    `Overall: ${wr.rate}% · Expectancy: ${wr.expectancy}`,
    `Wins: ${wr.wins} | Losses: ${wr.losses} | Total: ${wr.total}`,
    `Avg win: +${wr.avgWin}% | Avg loss: -${wr.avgLoss}%`,
    wr.insufficient?`⚠️ Insufficient data (min 20 per regime)`:'',``,
    `By regime:`,...lines
  ].filter(Boolean).join('\n'));
});

bot.onText(/\/shadowreport/,async()=>{
  const shadows=(state.shadowTrades||[]).filter(t=>t.shadowTrade);
  if(shadows.length<5){await send(`Shadow trades logged: ${shadows.length}\nNeed 50 cycles before evaluation.`);return;}
  const closed=shadows.filter(t=>t.outcome!==null);
  const pending=shadows.filter(t=>t.outcome===null);
  await send([`🔬 *Shadow Report — CAUTIOUS_EXPANSION*`,``,
    `Total candidates: ${shadows.length}`,
    `Closed: ${closed.length} | Pending: ${pending.length}`,
    closed.length>=5?`Shadow win rate: ${Math.round(closed.filter(t=>t.outcome==='WIN').length/closed.length*100)}%`:'Insufficient closed trades',
    ``,`Status: ${shadows.length>=50?'Ready for evaluation':'Accumulating ('+shadows.length+'/50)'}`
  ].join('\n'));
});

bot.onText(/\/position/,async()=>{
  if(!state.openPosition){await send('No open position.');return;}
  const p=state.openPosition;
  await send(`📈 *Open Position*\n\n${p.token} (Tier ${p.tier})\nRegime at entry: ${p.regime}\nEntry: $${p.entryPrice.toFixed(6)}\nStop: $${p.stopPrice.toFixed(6)}\nTarget: $${p.targetPrice.toFixed(6)}\nExploration trade: ${p.explorationTrade?'YES':'no'}`);
});

bot.onText(/\/pause/,async()=>{state.paused=true;saveState(state);await send('⏸ Paused.');});
bot.onText(/\/resume/,async()=>{state.paused=false;saveState(state);await send('▶️ Resumed.');});

bot.onText(/\/balance/,async()=>{
  const bal=await fetchWalletBalance(WALLET_ADDR);
  await send(bal?`💰 *${bal.toFixed(4)} SOL*`:'❌ Could not fetch balance.');
});

bot.onText(/\/setup/,async()=>{
  if(!JSONBIN_KEY){await send('❌ Add JSONBIN_KEY to Render env.');return;}
  if(JSONBIN_BIN){await send(`✅ JSONBin configured: ${JSONBIN_BIN}`);return;}
  try{
    const res=await fetch(JSONBIN_BASE,{method:'POST',
      headers:{'Content-Type':'application/json','X-Master-Key':JSONBIN_KEY,'X-Bin-Name':'solos-state','X-Bin-Private':'false'},
      body:JSON.stringify({initialized:true,cycleNum:0})});
    const d=await res.json();
    console.log('JSONBin create:',JSON.stringify(d));
    const binId=d?.metadata?.id;
    if(binId) await send(`✅ JSONBin created!\n\nBin ID: \`${binId}\`\n\nAdd to Render env:\nJSONBIN_BIN = ${binId}`);
    else await send('❌ Failed: '+JSON.stringify(d).slice(0,200));
  }catch(e){await send('❌ JSONBin error: '+e.message);}
});

// ── CRON ──────────────────────────────────────────────────────────────────────
cron.schedule('*/15 * * * *',()=>executeCycle(false));

// ── HTTP + WEBHOOK ────────────────────────────────────────────────────────────
const server=http.createServer(async(req,res)=>{
  if(req.method==='POST'&&req.url===WEBHOOK_PATH){
    let body='';
    req.on('data',chunk=>body+=chunk);
    req.on('end',()=>{
      try{bot.processUpdate(JSON.parse(body));}catch(e){console.log('Webhook parse:',e.message);}
      res.writeHead(200).end('ok');
    });
    return;
  }
  if(req.url==='/health'){
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({
      status:'running', cycle:state.cycleNum, uptime:process.uptime(),
      paused:state.paused, volState:state.volCycleCount<10?'warming':'stable',
      openPosition:state.openPosition?.token||null, winRate:state.winRate||null,
      explorationKillSwitch:state.explorationKillSwitch,
      shadowTrades:state.shadowTrades?.length||0
    }));
    return;
  }
  res.writeHead(200).end('SolOS Phase 4');
});

server.listen(PORT,async()=>{
  console.log(`SolOS Phase 4 listening on port ${PORT}`);
  if(RENDER_URL){
    const webhookUrl=`${RENDER_URL}${WEBHOOK_PATH}`;
    try{await bot.setWebHook(webhookUrl);console.log('Webhook set:',webhookUrl);}
    catch(e){console.log('Webhook failed:',e.message);}
  } else {
    console.log('No RENDER_EXTERNAL_URL — add to Render env vars');
  }
  setTimeout(async()=>{
    await send(`🚀 *SolOS Combined Build 1 Active*\nWebhook mode · InvestOS bridge · NEUTRAL\\_DEGRADED regime\nWallet: ${WALLET_ADDR?WALLET_ADDR.slice(0,6)+'...'+WALLET_ADDR.slice(-4):'not set'}\n\n/status to check`);
    setTimeout(()=>executeCycle(false),3000);
  },2000);
});
