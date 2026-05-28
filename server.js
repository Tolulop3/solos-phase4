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
const { runCycle, fetchWalletBalance, fetchTokenPrice, TIER1_TOKENS, TIER2_TOKENS, TIER3_TOKENS, TOKEN_META } = require('./solos-engine');

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
    timeStopCycles:8,
    cooldownAfterFailHours:4,
    killOnFreshRiskOff:true,
    killOnVolSpike:true,
    // Relaxed entry conditions — SOL direction no longer a hard gate
    confidenceMin:82,      // was 88
    tradabilityMin:75,     // was 82
    fragilityMax:12,       // was 8
    persistenceMinutes:60, // was 120 — 1 hour not 2
    signalAgeMin:6,
    probeWinRateMin:40,
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
// TOKEN_STYLES — derived from TOKEN_META (single source of truth in solos-engine.js)
// Returns styles for a token, or empty array if unknown
function getTokenStyles(token) {
  if(TOKEN_META && TOKEN_META[token]) return TOKEN_META[token].styles || [];
  // Fallback for any token not in registry
  return ['momentum'];
}
// For backwards compatibility — build static map after TOKEN_META loads
const TOKEN_STYLES = TOKEN_META
  ? Object.fromEntries(Object.entries(TOKEN_META).map(([k,v])=>[k,v.styles]))
  : { JTO:['momentum','defensive'], BONK:['momentum','breakout'], WIF:['momentum','breakout'],
      PYTH:['growth','defensive'], RAY:['momentum','growth'] };

const VOL_SIZE_MULT = { LOW:1.2, MED:1.0, HIGH:0.75, VHIGH:0.5 };


// Computed decision — derives regime, exposure, styles from raw InvestOS data
// This is the single source of truth. SolOS never interprets raw macro/market directly.
function computeInvestOSDecision(inv) {
  if(!inv) {
    return { regime:'NEUTRAL', exposure:0.4, styles:['pullback','defensive'],
      score:0, note:'InvestOS unavailable — defensive default' };
  }

  // If InvestOS provides a unified regime, use it directly
  // This reconciles news + technical + ML internally
  if(inv.unifiedRegime && inv.systemExposure !== null) {
    const unifiedMap = {
      'RISK_ON':  { exposure: inv.systemExposure || 0.5, styles:['momentum','breakout','pullback','defensive'] },
      'NEUTRAL':  { exposure: Math.min(inv.systemExposure || 0.4, 0.6), styles:['pullback','momentum','mean_reversion','defensive'] },
      'DEFENSIVE':{ exposure: Math.min(inv.systemExposure || 0.3, 0.4), styles:['pullback','defensive','low_vol','mean_reversion'] },
      'RISK_OFF': { exposure: Math.min(inv.systemExposure || 0.15, 0.2), styles:['mean_reversion_small','defensive'] },
    };
    const mapped = unifiedMap[inv.unifiedRegime] || unifiedMap['NEUTRAL'];
    // Use InvestOS allowed_styles if provided, else use mapped defaults
    const styles = inv.allowedStyles?.length ? inv.allowedStyles : mapped.styles;
    // Cap exposure if macro news is RISK_OFF (hard risk layer)
    const exposure = inv.macroRegime === 'RISK_OFF'
      ? Math.min(mapped.exposure, 0.3)  // news risk caps exposure even if unified is bullish
      : mapped.exposure;

    console.log(`InvestOS unified decision: ${inv.unifiedRegime} → exposure=${exposure.toFixed(2)} styles=[${styles.join(',')}]`);
    return {
      regime: inv.unifiedRegime,
      exposure,
      styles,
      score: inv.unifiedScore || 0,
      note: `Unified: ${inv.unifiedRegime} (score=${inv.unifiedScore?.toFixed(2)}) macro=${inv.macroRegime}`,
      raw: { macro:inv.macroRegime, market:inv.marketRegime, unified:inv.unifiedRegime,
             sol:inv.solDirection+'@'+inv.solConviction+'%', age:inv.ageHours+'h' }
    };
  }

  // Fallback: compute from components if unified not available
  let score=0;
  if(inv.marketRegime==='BULL')  score++;
  else if(inv.marketRegime==='BEAR') score-=2;
  if(inv.macroRegime==='BULL'||inv.macroRegime==='NORMAL') score++;
  else if(inv.macroRegime==='CAUTIOUS') score--;
  else if(inv.macroRegime==='RISK_OFF') score-=2;
  if(inv.health==='STRONG')   score++;
  else if(inv.health==='DEGRADED') score--;
  else if(inv.health==='CRITICAL') score-=2;
  if(inv.solDirection==='LONG'&&inv.solConviction>=70) score=Math.min(score+1,4);
  else if(inv.solDirection==='SHORT') score=Math.max(score-1,-4);
  if(!inv.fresh) score=Math.min(score,0);

  const map=[
    [3,'RISK_ON',1.0,['momentum','breakout','high_beta','pullback']],
    [2,'RISK_ON',0.85,['momentum','breakout','pullback','defensive']],
    [1,'NEUTRAL',0.6,['pullback','momentum','mean_reversion','defensive']],
    [0,'DEFENSIVE',0.4,['pullback','defensive','low_vol','mean_reversion']],
    [-1,'DEFENSIVE',0.3,['pullback','defensive','low_vol']],
    [-2,'CAPITAL_PRESERVATION',0.15,['mean_reversion_small','defensive']],
  ];
  const row=map.find(([s])=>score>=s)||[-99,'STRESS',0.0,[]];
  console.log(`InvestOS fallback decision: ${row[1]} score=${score} exposure=${row[2]}`);
  return { regime:row[1], exposure:row[2], styles:row[3], score,
    note:`Fallback score ${score}→${row[1]}`,
    raw:{ macro:inv.macroRegime, market:inv.marketRegime, sol:inv.solDirection+'@'+inv.solConviction+'%', age:inv.ageHours+'h' } };
}

async function fetchInvestOSMacro() {
  try {
    const r = await fetch(INVESTOS_URL, { signal:AbortSignal.timeout(6000) });
    if(!r.ok) return null;
    const b = await r.json();
    const generatedAt = b.generated_at ? new Date(b.generated_at) : null;
    const ageHours = generatedAt ? (Date.now()-generatedAt.getTime())/3600000 : 999;

    // Raw macro from news engine
    const macroRegime = b.macro?.regime || 'NORMAL';

    // UNIFIED regime from system_exposure — this reconciles news + technical + ML
    // This is the authoritative signal, not just the news-driven macro
    const sys = b.system_exposure || {};
    const unifiedRegime  = sys.unified_regime  || null;
    const unifiedScore   = sys.unified_score   || 0;
    const unifiedConf    = sys.confidence      || 0;
    const systemExposure = sys.pct             || null; // 0.0-1.0
    const marketScore    = sys.market_score    || 0;
    const macroScore     = sys.macro_score     || 0;
    const healthScore    = sys.health_score    || 0;

    // Allowed styles — prefer system_exposure styles (reconciled), fall back to macro
    const allowedStyles = sys.allowed_styles || b.allowed_styles || b.macro?.allowed_styles || [];
    const blockedStyles = sys.blocked_styles || b.blocked_styles || b.macro?.blocked_styles || [];

    // Health derived from health_score if not explicit
    const health = b.health || b.macro?.health ||
      (healthScore >= 0.5 ? 'STRONG' : healthScore >= 0 ? 'NORMAL' : 'DEGRADED');

    const m = {
      macroRegime,           // raw news signal
      unifiedRegime,         // reconciled signal — PRIMARY
      unifiedScore,          // -1 to +1 scalar
      unifiedConf,           // confidence 0-1
      systemExposure,        // 0-1 exposure from InvestOS
      marketScore,           // SPX technical component
      macroScore,            // news/macro component
      healthScore,           // system health component
      marketRegime:  b.market_regime?.regime || 'BULL',
      solConviction: b.crypto?.assets?.['SOL-USD']?.conviction || 0,
      solDirection:  b.crypto?.assets?.['SOL-USD']?.direction || 'NEUTRAL',
      btcConviction: b.crypto?.assets?.['BTC-USD']?.conviction || 0,
      btcDirection:  b.crypto?.assets?.['BTC-USD']?.direction || 'NEUTRAL',
      timestamp:     b.generated_at || null,
      ageHours:      +ageHours.toFixed(1),
      fresh:         ageHours <= 8,
      allowedStyles, blockedStyles, health,
      exposure: systemExposure || 1.0
    };
    console.log(`InvestOS: macro=${m.macroRegime} unified=${m.unifiedRegime} score=${m.unifiedScore?.toFixed(2)} exposure=${m.systemExposure} SOL=${m.solDirection}@${m.solConviction}% age=${m.ageHours}h`);
    return m;
  } catch(e) { console.log('InvestOS unavailable'); return null; }
}

// ── REGIME OVERRIDE — uses computeInvestOSDecision as single source of truth ──
function applyInvestOSOverride(localRegime, inv, scores) {
  // Get computed decision from InvestOS
  const decision = computeInvestOSDecision(inv);
  const { regime:investosRegime, exposure, styles, score, note } = decision;

  // Map InvestOS computed regime to SolOS regime enum
  // InvestOS decision is the authority — local regime only adds context
  let finalRegime;

  if(investosRegime === 'STRESS') {
    finalRegime = 'STRESS';
  } else if(investosRegime === 'CAPITAL_PRESERVATION') {
    const cfg = REGIME_CONFIG.PROBE;
    // SOL direction gate — SHORT with high conviction still blocks
    // NEUTRAL or SHORT with low conviction (<50%) allows PROBE
    const solDirectionOk = !inv || 
      inv.solDirection !== 'SHORT' || 
      inv.solConviction < 50;

    const probeEligible = inv && inv.ageHours >= cfg.signalAgeMin &&
      localRegime === 'EXPANSION' &&
      scores && scores.confidence >= cfg.confidenceMin &&
      scores.tradability >= cfg.tradabilityMin &&
      scores.fragility <= cfg.fragilityMax &&
      solDirectionOk &&
      !state.probeSuspended &&
      (!state.probeCooldownUntil || Date.now() > state.probeCooldownUntil);

    console.log(`PROBE check: age=${inv?.ageHours}h conf=${scores?.confidence} trade=${scores?.tradability} frag=${scores?.fragility} sol=${inv?.solDirection}@${inv?.solConviction}% eligible=${probeEligible}`);

    if(probeEligible) {
      const now = Date.now();
      if(!state.probePersistenceStart) {
        state.probePersistenceStart = now;
        console.log('PROBE persistence started — conditions met, building 1h');
      }
      const persistMins = (now - state.probePersistenceStart) / 60000;
      if(persistMins >= cfg.persistenceMinutes) {
        finalRegime = 'PROBE';
      } else {
        finalRegime = 'STRESS';
        console.log(`PROBE building: ${Math.round(persistMins)}/${cfg.persistenceMinutes}min`);
      }
    } else {
      if(state.probePersistenceStart) {
        state.probePersistenceStart = null;
        console.log('PROBE conditions lost — resetting persistence');
      }
      finalRegime = 'STRESS';
    }
  } else if(investosRegime === 'DEFENSIVE') {
    finalRegime = 'NEUTRAL_DEGRADED';
  } else if(investosRegime === 'NEUTRAL') {
    finalRegime = localRegime === 'EXPANSION' ? 'NEUTRAL' : 'NEUTRAL';
  } else if(investosRegime === 'RISK_ON') {
    // InvestOS unified says RISK_ON — allow trading
    // Even if macro news = RISK_OFF, unified reconciled it as RISK_ON
    if(localRegime === 'EXPANSION' && inv?.solConviction >= 65 && inv?.solDirection === 'LONG') {
      finalRegime = 'EXPANSION_CONFIRMED';
    } else if(localRegime === 'EXPANSION') {
      finalRegime = 'EXPANSION';
    } else {
      finalRegime = 'NEUTRAL'; // unified bullish but local not expansion yet
    }
  } else {
    finalRegime = localRegime;
  }

  // Shadow candidate check
  const shadowCandidate = investosRegime==='DEFENSIVE' && localRegime==='EXPANSION' &&
    inv?.solConviction>=70 && inv?.solDirection==='LONG' && inv?.btcDirection==='LONG';

  return {
    regime: finalRegime,
    source: inv ? 'investos' : 'local',
    note: note,
    allowedStyles: styles,          // always populated — never empty unless STRESS
    exposure: finalRegime==='PROBE' ? 0.25 : exposure,
    health: inv?.health || 'NORMAL',
    score,
    shadowCandidate: shadowCandidate || false
  };
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
    state.explorationKillSwitch = false;
    state.explorationLossCount = 0;
    state.explorationLossPct = 0;
    state.explorationKillUntil = null;
  }

  // Max concurrent positions
  if(state.openPosition) {
    return { eligible:false, reason:'Exploration position already open' };
  }

  // InvestOS unavailable — allow with simulation (don't block entirely)
  if(!inv) {
    if(!scores || scores.sanity < 0.55)
      return { eligible:false, reason:`No InvestOS + sanity ${scores?Math.round(scores.sanity*100):'?'} too low` };
    return { eligible:true, reason:'InvestOS unavailable — local signals only', whaleProxy:true };
  }

  // Conviction threshold — relaxed (SOL SHORT low conviction still allowed)
  if(inv && inv.solConviction >= 55 && inv.solDirection === 'SHORT')
    return { eligible:false, reason:`SOL SHORT conviction ${inv.solConviction}% too high — waiting for ≤54%` };

  // Sanity threshold — 50 minimum (was 58)
  if(!scores || scores.sanity < 0.50)
    return { eligible:false, reason:`Sanity ${scores?Math.round(scores.sanity*100):'?'} below 50 threshold` };

  // Tradability — 60 minimum
  if(!scores || scores.tradability < 0.60)
    return { eligible:false, reason:`Tradability ${scores?Math.round(scores.tradability*100):'?'} below 60` };

  // Persistence guard — only after first 3 trades, not before
  const closedTrades = (state.tradeLog||[]).filter(t=>t.outcome!==null).length;
  if(closedTrades >= 5) {
    const now = Date.now();
    const persistMinutes = state.explorationSignalTime
      ? (now - state.explorationSignalTime) / 60000 : 0;
    if(state.explorationSignalSeen < 2 && persistMinutes < 30) {
      state.explorationSignalSeen = (state.explorationSignalSeen||0) + 1;
      if(!state.explorationSignalTime) state.explorationSignalTime = now;
      return { eligible:false,
        reason:`Persistence guard: ${state.explorationSignalSeen}/2 cycles, ${persistMinutes.toFixed(0)}min/30min` };
    }
  }

  return { eligible:true, reason:`Eligible · conviction ${inv.solConviction}% · sanity ${Math.round(scores.sanity*100)} · tradability ${Math.round(scores.tradability*100)}`, whaleProxy:true };
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
      overrideNote:override?.note||null,
      investosDecision: override ? {
        regime: override.regime,
        score: override.score,
        exposure: override.exposure,
        styles: override.allowedStyles,
        health: override.health
      } : null
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
  const dec=computeInvestOSDecision(inv);
  return [
    'SolOS Cycle '+result.cycleNum,
    regimeEmoji(override?.regime||r.dominant)+' Regime: '+(override?.regime||r.dominant),
    'Confidence: '+Math.round(r.confidence*100)+' | Sanity: '+Math.round(result.sanity*100),
    'Tradability: '+Math.round(s.tradability*100)+' | Fragility: '+Math.round(s.fragility*100),
    inv?'Macro: '+inv.macroRegime+' | SOL: '+inv.solDirection+' '+inv.solConviction+'% | age: '+inv.ageHours+'h':'Macro: unavailable',
    'Decision: '+dec.regime+' | Exposure: '+(dec.exposure*100).toFixed(0)+'%',
    'Styles: '+(dec.styles.join(', ')||'none'),
    state.volCycleCount<10?'Vol warming ('+state.volCycleCount+'/10)':'',
    'Wallet: '+(result.walletBalance?result.walletBalance.toFixed(4)+' SOL':'not connected'),
    'Status: '+result.action
  ].filter(Boolean).join('\n');
}

function formatTradeProposal(result,inv,override,explCheck) {
  const p=result.proposal;
  const dec=computeInvestOSDecision(inv);
  const hasRealPrice = p.tokenPrice && p.tokenPrice > 0;
  const priceStr = hasRealPrice ? '$'+p.tokenPrice.toFixed(8) : 'price pending';
  const stopStr = hasRealPrice
    ? `Stop: -${p.stops.stopPct}% ($${p.stops.stopPrice?.toFixed(8)||'?'})`
    : `Stop: -${p.stops.stopPct}%`;
  const targetStr = hasRealPrice
    ? `Target: +${p.stops.targetPct}% ($${p.stops.targetPrice?.toFixed(8)||'?'})`
    : `Target: +${p.stops.targetPct}%`;

  // Jupiter URL — works with Phantom on mobile
  const jupUrl = `https://jup.ag/swap/SOL-${p.token}`;

  return [
    'TRADE PROPOSED — Cycle '+result.cycleNum,
    '',
    'SOL to '+p.token+' (Tier '+p.tier+')',
    'Amount: '+p.amountSOL+' SOL',
    'Entry: '+priceStr,
    '',
    stopStr,
    targetStr,
    'Backstop: -'+p.stops.backstopPct+'%',
    '',
    'Expansion: '+Math.round(result.regime.expProb*100)+'% | Sanity: '+Math.round(result.sanity*100),
    inv?'Macro: '+inv.macroRegime+' | Unified: '+dec.regime+' '+Math.round(dec.exposure*100)+'%':'',
    p.dataSource==='live'?'Signal: LIVE DATA':'Signal: cached/estimated',
    '',
    jupUrl,
    '',
    'Open link in Phantom wallet to execute swap',
    'Tap Approve to confirm or Skip to cancel'
  ].filter(Boolean).join('\n');
}

function formatPositionAlert(pos,update) {
  return [
    update.action+' — '+pos.token,
    '',
    'PnL: '+(update.pnlPct>=0?'+':'')+update.pnlPct.toFixed(1)+'%',
    'Entry: '+pos.entryPrice.toFixed(4)+' | Now: '+update.currentPrice.toFixed(4),
    'Cycles held: '+update.cyclesHeld,
    '',
    'Tap Exit now or Hold below'
  ].join('\n');
}

// ── SEND ──────────────────────────────────────────────────────────────────────
async function send(text, opts={}) {
  try { await bot.sendMessage(CHAT_ID, text, opts); }
  catch(e){console.error('Send failed:',e.message);}
}

// Send with bold formatting for simple static messages only
async function sendMd(text, opts={}) {
  try { await bot.sendMessage(CHAT_ID, text, { parse_mode:'Markdown', ...opts }); }
  catch(e){
    console.error('SendMd failed:',e.message,'— retrying as plain text');
    try { await bot.sendMessage(CHAT_ID, text.replace(/[*_`]/g,''), opts); }
    catch(e2){ console.error('Plain retry failed:',e2.message); }
  }
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
    // Fetch InvestOS first so styles are available to engine's pickToken
    const investos = await fetchInvestOSMacro();
    const preDecision = computeInvestOSDecision(investos);
    state.currentAllowedStyles = preDecision.styles || [];

    // Run engine cycle
    const result = await runCycle(state, WALLET_ADDR);
    state.cycleNum = result.cycleNum;
    state.volCycleCount = Math.min((state.volCycleCount||0)+1, 20);

    // If price unavailable, log but continue — InvestOS can still force a trade
    // using cached price for stop calculation. Only block if no cache at all.
    if(result.marketData?.tradingDisabled) {
      console.log('[CYCLE] Price unavailable — using InvestOS-only mode');
      if(manual) await send('⚠️ Price feeds down — running InvestOS-only mode. Trade sizing conservative.');
      // Don't return — continue with InvestOS override which may force a trade
    }

    // Apply regime override with scores for CAUTIOUS_EXPANSION shadow check
    const scores = {
      ...result.scores,
      confidence: result.regime.confidence,
      sanity: result.sanity
    };
    const override = applyInvestOSOverride(result.regime.dominant, investos, scores);
    const finalRegime = override.regime;

    // Notify when PROBE starts building persistence
    if(finalRegime === 'STRESS' && override.note?.includes('PROBE') === false &&
       state.probePersistenceStart && !state._probeNotified) {
      state._probeNotified = true;
      await send('🔬 PROBE conditions met — building 1h persistence. Will alert when ready to probe.');
    }
    if(!state.probePersistenceStart) state._probeNotified = false;

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

    // ── FORCE TRADE PROPOSAL when InvestOS overrides to EXPANSION ──────────────
    // The engine returns STAKE/BLOCKED when local regime is not EXPANSION,
    // but InvestOS says RISK_ON/NEUTRAL → allow trade. Override and propose.
    const engineBlocked = ['STAKE','BLOCKED'].includes(result.action);
    const forceEligible = finalRegime==='EXPANSION' || finalRegime==='EXPANSION_CONFIRMED' ||
      (finalRegime==='NEUTRAL_DEGRADED' && checkExplorationEligible(investos, scores).eligible) ||
      (finalRegime==='NEUTRAL' && scores?.sanity >= 0.42);

    if(forceEligible &&
       !state.openPosition &&
       engineBlocked &&
       result.action!=='EXIT_NEEDED' &&
       result.action!=='EMERGENCY') {

      const walletBal = result.walletBalance || state.totalSOL || 0.5;
      // Size by regime — NEUTRAL_DEGRADED gets half exposure
      const baseExposure = Math.min(override.exposure || 0.3, 0.3);
      const regimeSizeMult = finalRegime==='NEUTRAL_DEGRADED' ? 0.5 :
                             finalRegime==='NEUTRAL' ? 0.7 : 1.0;
      const exposure = baseExposure * regimeSizeMult;
      const swapSOL = +(walletBal * exposure * 0.22 * volMult).toFixed(4);

      // Pick token using scored selection across all tiers
      const allowed = override.allowedStyles || [];
      const allTokens = { ...TIER1_TOKENS, ...TIER2_TOKENS,
        ...(finalRegime==='EXPANSION_CONFIRMED' ? TIER3_TOKENS : {}) };

      // Score each token by style match
      const tokenScores = Object.entries(allTokens).map(([sym, mint]) => {
        const meta = TOKEN_META?.[sym] || { styles:['momentum'], vol:'MED' };
        const tier = TIER3_TOKENS?.[sym] ? 3 : TIER2_TOKENS?.[sym] ? 2 : 1;
        const styleMatch = allowed.length ? meta.styles.filter(s=>allowed.includes(s)).length : 0;
        const volMult = VOL_SIZE_MULT?.[meta.vol] || 1.0;
        return { sym, mint, tier, meta, styleMatch, volMult, score: styleMatch*10 + (4-tier)*5 + Math.random()*3 };
      });
      tokenScores.sort((a,b)=>b.score-a.score);
      const best = tokenScores[0] || { sym:'JTO', mint:TIER1_TOKENS.JTO, tier:1, volMult:1.0 };
      const token = best.sym;
      const mint  = best.mint;
      const volMult = best.volMult;

      // Fetch real token price for accurate stops
      let tokenPrice = null;
      try {
        tokenPrice = await fetchTokenPrice(mint);
        console.log(`[OVERRIDE] Token price ${token}: $${tokenPrice}`);
      } catch(e) { console.log(`[OVERRIDE] Token price fetch failed: ${e.message}`); }

      // Vol-adjusted stops
      const vol = result.marketData?.volatility || 0.3;
      const stopPct    = +(Math.min(12, Math.max(5, 1.2 * vol * 100))).toFixed(1);
      const targetPct  = +(stopPct * 2.5).toFixed(1);
      const backstopPct= +(stopPct * 2.8).toFixed(1);

      // Real price-anchored stops if we have token price
      const stops = tokenPrice ? {
        stopPct, targetPct, backstopPct,
        stopPrice:   +(tokenPrice*(1-stopPct/100)).toFixed(8),
        targetPrice: +(tokenPrice*(1+targetPct/100)).toFixed(8),
        backstopPrice: +(tokenPrice*(1-backstopPct/100)).toFixed(8),
        entryPrice: tokenPrice
      } : { stopPct, targetPct, backstopPct };

      result.action = 'TRADE_PROPOSED';
      result.proposal = {
        token, mint,
        tier: TIER2_TOKENS[token] ? 2 : 1,
        amountSOL: swapSOL,
        stops,
        tokenPrice,
        jupUrl: `https://jup.ag/swap/SOL-${token}`,
        dataSource: tokenPrice ? 'live' : (result.marketData?.source || 'cached'),
        priceImpact: 0,
        forcedByOverride: true
      };
      console.log(`[OVERRIDE] EXPANSION forced trade: ${token} ${swapSOL} SOL at $${tokenPrice||'?'}`);
    }

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
        } else if(finalRegime==='PROBE') {
          // PROBE — passes through, sizing already applied
        } else if(finalRegime==='NEUTRAL_DEGRADED') {
          explCheck = checkExplorationEligible(investos, scores);
          if(!explCheck.eligible) { blocked=true; blockReason=explCheck.reason; }
        } else if(finalRegime==='NEUTRAL') {
          // NEUTRAL — allow if sanity passes basic threshold
          if(!scores || scores.sanity < 0.42) {
            blocked=true; blockReason=`NEUTRAL sanity ${scores?Math.round(scores.sanity*100):'?'} below 42`;
          }
        }
        // CAPITAL_PRESERVATION — allow mean_reversion_small style trades at tiny size
        // Already style-filtered above — if style passed, allow at 15% exposure
        // EXPANSION / EXPANSION_CONFIRMED — allow freely
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
    const swapUrl = `https://jup.ag/swap/SOL-${p.token}`;
    await send([
      'Approved',
      '',
      p.amountSOL+' SOL to '+p.token,
      'Entry: $'+entryPrice.toFixed(6),
      'Stop: $'+state.openPosition.stopPrice.toFixed(6)+' (-'+p.stops.stopPct+'%)',
      'Target: $'+state.openPosition.targetPrice.toFixed(6)+' (+'+p.stops.targetPct+'%)',
      '',
      'To execute the swap:',
      '1. Install Phantom wallet (phantom.app) - supports Solana',
      '2. Open this link:',
      swapUrl,
      '',
      'Note: MetaMask does not support Solana. Use Phantom.'
    ].join('\n'));
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
bot.onText(/\/start/,async()=>{
  console.log('[CMD] /start received');
  await send(`👋 *SolOS Active*\n\n/ping /status /run /position /winrate /shadowreport /pause /resume /balance /setup`);
});

bot.onText(/\/status/,async()=>{
  console.log('[CMD] /status received');
  const bal=WALLET_ADDR?await fetchWalletBalance(WALLET_ADDR):null;
  const inv=await fetchInvestOSMacro();
  const dec=computeInvestOSDecision(inv);
  const pos=state.openPosition;
  const wr=state.winRate;
  await send([
    'SolOS Status',
    '',
    'Cycles: '+state.cycleNum+' | Vol: '+(state.volCycleCount<10?'warming ('+state.volCycleCount+'/10)':'stable'),
    'Wallet: '+(bal?bal.toFixed(4)+' SOL':'n/a'),
    'Open position: '+(pos?pos.token+' ('+pos.regime+')':'none'),
    'Auto: '+(state.paused?'PAUSED':'RUNNING'),
    'Exploration kill: '+(state.explorationKillSwitch?'ACTIVE':'off'),
    'Probe: '+(state.probeSuspended?'SUSPENDED':state.probeCooldownUntil&&Date.now()<state.probeCooldownUntil?'cooldown':'ready'),
    'Win rate: '+(wr?wr.rate+'% expectancy '+wr.expectancy+' ('+wr.total+' trades)':'no data yet'),
    '',
    'InvestOS: '+dec.regime+' score='+dec.score+' exposure='+(dec.exposure*100).toFixed(0)+'%',
    'Macro: '+(inv?inv.macroRegime:'unavailable')+' | Market: '+(inv?inv.marketRegime:'—'),
    'SOL: '+(inv?inv.solDirection+' '+inv.solConviction+'%':'—')+' | Age: '+(inv?inv.ageHours+'h':'—'),
    'Styles: '+(dec.styles.join(', ')||'none')
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

bot.onText(/\/ping/,async()=>{
  console.log('[CMD] /ping received');
  await send('🏓 pong — bot is alive and receiving commands');
});

bot.onText(/\/pause/,async()=>{state.paused=true;saveState(state);await send('⏸ Paused.');});
bot.onText(/\/resume/,async()=>{state.paused=false;saveState(state);await send('▶️ Resumed.');});

bot.onText(/\/balance/,async()=>{
  const bal=await fetchWalletBalance(WALLET_ADDR);
  await send(bal?`💰 *${bal.toFixed(4)} SOL*`:'❌ Could not fetch balance.');
});

bot.onText(/\/setup/,async()=>{
  console.log('[CMD] /setup received');
  if(!JSONBIN_KEY){await send('❌ Add JSONBIN_KEY to Render env.');return;}
  if(JSONBIN_BIN){await send(`✅ JSONBin configured: ${JSONBIN_BIN}`);return;}
  try{
    const res=await fetch(JSONBIN_BASE,{method:'POST',
      headers:{'Content-Type':'application/json','X-Master-Key':JSONBIN_KEY,'X-Bin-Name':'solos-state','X-Bin-Private':'false'},
      body:JSON.stringify({initialized:true,cycleNum:0})});
    const d=await res.json();
    console.log('JSONBin create:',JSON.stringify(d));
    const binId=d?.metadata?.id;
    if(binId) await send(`✅ JSONBin created!\n\nBin ID: ${binId}\n\nAdd to Render env:\nJSONBIN_BIN = ${binId}`);
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
      try{
        const update=JSON.parse(body);
        console.log('[WEBHOOK] received update_id:', update.update_id, 'type:', update.message?'message':update.callback_query?'callback':'other');
        bot.processUpdate(update);
      }catch(e){console.log('[WEBHOOK] parse error:',e.message);}
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
    try{
      // First delete any existing webhook
      await bot.deleteWebHook();
      console.log('Old webhook cleared');
      // Set new webhook
      const result = await bot.setWebHook(webhookUrl);
      console.log('Webhook set result:', result);
      console.log('Webhook URL registered: '+RENDER_URL+'/webhook/***MASKED***');
      // Verify it was set correctly
      const info = await bot.getWebHookInfo();
      console.log('Webhook info: url='+(info.url?info.url.replace(BOT_TOKEN,'***'):'none')+
        ' pending='+info.pending_update_count+' error='+(info.last_error_message||'none'));
    } catch(e){
      console.log('Webhook setup failed:', e.message);
      console.log('Falling back to polling mode...');
      try {
        bot.startPolling({ restart:false });
        console.log('Polling mode active');
      } catch(pe) { console.log('Polling also failed:', pe.message); }
    }
  } else {
    console.log('No RENDER_EXTERNAL_URL — falling back to polling');
    try {
      await bot.deleteWebHook();
      bot.startPolling({ restart:false });
      console.log('Polling mode active');
    } catch(e) { console.log('Polling failed:', e.message); }
  }

  setTimeout(async()=>{
    await send(`🚀 *SolOS Active*\nWallet: ${WALLET_ADDR?WALLET_ADDR.slice(0,6)+'...'+WALLET_ADDR.slice(-4):'not set'}\n\n/status to check`);
    const delay = 15000 + Math.random()*30000;
    console.log(`First cycle in ${Math.round(delay/1000)}s`);
    setTimeout(()=>executeCycle(false), delay);
  },3000);
});
