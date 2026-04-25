'use strict';

const fetch = require('node-fetch');

const HELIUS = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';

const TIER1_TOKENS = {
  JTO:  'jtojtomepa8bdhhpphliqfm3z15chejkqshhq4wr5a',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF:  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'
};

const TIER2_TOKENS = {
  PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
  RAY:  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'
};

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ── MARKET DATA ──────────────────────────────────────────────────────────────
function generateMarketSim() {
  const regimeSeed = Math.random();
  let volatility, trend7d, trend24h, volumeRatio, liquidityDepth, spreadScore;

  if(regimeSeed < 0.40) {
    volatility    = 0.15 + Math.random() * 0.30;
    trend7d       = 0.05 + Math.random() * 0.15;
    trend24h      = 0.01 + Math.random() * 0.05;
    volumeRatio   = 1.1  + Math.random() * 0.6;
    liquidityDepth= 0.6  + Math.random() * 0.4;
    spreadScore   = 0.7  + Math.random() * 0.3;
  } else if(regimeSeed < 0.85) {
    volatility    = 0.25 + Math.random() * 0.35;
    trend7d       = -0.03 + Math.random() * 0.06;
    trend24h      = -0.02 + Math.random() * 0.04;
    volumeRatio   = 0.7  + Math.random() * 0.6;
    liquidityDepth= 0.4  + Math.random() * 0.4;
    spreadScore   = 0.5  + Math.random() * 0.4;
  } else {
    volatility    = 0.55 + Math.random() * 0.40;
    trend7d       = -0.12 + Math.random() * 0.06;
    trend24h      = -0.06 + Math.random() * 0.03;
    volumeRatio   = 1.3  + Math.random() * 0.7;
    liquidityDepth= 0.2  + Math.random() * 0.3;
    spreadScore   = 0.3  + Math.random() * 0.3;
  }
  return { volatility, trend7d, trend24h, volumeRatio, liquidityDepth, spreadScore };
}

async function fetchMarketData() {
  const sim = generateMarketSim();
  try {
    const res = await fetch(COINGECKO);
    const d   = await res.json();
    const price = d?.solana?.usd || 140;
    return { price, ...sim };
  } catch(e) {
    return { price: 140, ...sim };
  }
}

// ── WALLET BALANCE ───────────────────────────────────────────────────────────
async function fetchWalletBalance(address) {
  try {
    const res = await fetch(HELIUS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getBalance', params:[address, {commitment:'confirmed'}] })
    });
    const d = await res.json();
    return d?.result?.value ? d.result.value / 1e9 : null;
  } catch(e) { return null; }
}

// ── CLAMP ────────────────────────────────────────────────────────────────────
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ── REGIME ENGINE ────────────────────────────────────────────────────────────
function detectRegime(d) {
  const rawExpansion = clamp((d.trend7d * 0.4) + (d.volumeRatio * 0.3) - (d.volatility * 0.3), -0.3, 0.7);
  const rawStress    = clamp((d.volatility * 0.5) + (d.trend24h < 0 ? Math.abs(d.trend24h) * 4 : 0), 0, 0.9);

  let expProb, neuProb, strProb;
  if(rawStress > 0.6) {
    strProb = clamp(rawStress, 0.5, 0.85);
    expProb = clamp(rawExpansion * (1 - strProb), 0, 0.3);
    neuProb = 1 - strProb - expProb;
  } else if(rawExpansion > 0.25) {
    expProb = clamp(rawExpansion + 0.3, 0.4, 0.8);
    strProb = clamp(rawStress * 0.5, 0, 0.25);
    neuProb = 1 - expProb - strProb;
  } else {
    neuProb = clamp(0.5 + Math.random() * 0.2, 0.4, 0.7);
    expProb = clamp(rawExpansion + 0.2, 0.1, 0.35);
    strProb = 1 - neuProb - expProb;
  }

  const total = expProb + neuProb + strProb;
  expProb /= total; neuProb /= total; strProb /= total;

  const dominant = expProb > neuProb && expProb > strProb ? 'EXPANSION'
    : strProb > neuProb ? 'STRESS' : 'NEUTRAL';
  const dominantProb = Math.max(expProb, neuProb, strProb);
  const confidence = clamp(dominantProb * 1.2 - (d.volatility * 0.2), 0.3, 0.95);

  return { expProb, neuProb, strProb, dominant, dominantProb, confidence };
}

// ── SCORES ───────────────────────────────────────────────────────────────────
function computeScores(d, state) {
  const recentLoss = state.consecutiveLosses || 0;
  const fragility  = clamp(0.05 + (recentLoss * 0.12) + (state.recoveryMode ? 0.2 : 0), 0, 1);

  const tradability = clamp(
    (d.liquidityDepth * 0.4) + (d.spreadScore * 0.35) + ((d.volumeRatio > 0.8 ? 1 : d.volumeRatio / 0.8) * 0.25),
    0, 1
  );

  const execQuality = clamp(1 - (d.volatility * 0.3) - (fragility * 0.2), 0.2, 1);

  let aggressionMult = 1.0;
  if((state.consecutiveWins || 0) >= 3) aggressionMult = 1.2;
  if((state.consecutiveLosses || 0) >= 2) aggressionMult = 0.6;
  if((state.consecutiveLosses || 0) >= 3) aggressionMult = 0.4;
  if(state.recoveryMode) aggressionMult = Math.min(aggressionMult, 0.5);

  const aggrNorm = clamp((aggressionMult - 0.3) / 0.9, 0, 1);

  return { fragility, tradability, execQuality, aggressionMult, aggrNorm };
}

// ── SANITY CHECK ─────────────────────────────────────────────────────────────
function computeSanity(regime, scores) {
  return clamp(
    (regime.dominantProb * 0.3) + (scores.tradability * 0.3) + (scores.aggrNorm * 0.2) - (scores.fragility * 0.2),
    0, 1
  );
}

// ── VOL-ADJUSTED STOPS ───────────────────────────────────────────────────────
function calcStops(entryPrice, volatility, tier) {
  // Cap volatility input so stops stay sensible
  const vol = Math.min(volatility, 0.35);
  const k   = tier === 1 ? 1.5 : 1.0;
  const rr  = tier === 1 ? 2.5 : 2.0;

  const stopDist    = clamp(k * vol, 0.04, 0.12);   // 4-12% stop
  const targetDist  = clamp(rr * stopDist, 0.08, 0.25); // 8-25% target
  const backstop    = clamp(2.8 * stopDist, 0.10, 0.30); // 10-30% backstop

  return {
    stopPct:     +(stopDist * 100).toFixed(1),
    targetPct:   +(targetDist * 100).toFixed(1),
    backstopPct: +(backstop * 100).toFixed(1)
  };
}

// ── ALLOCATION ───────────────────────────────────────────────────────────────
function computeAllocation(regime, scores, state) {
  const { dominant, expProb, strProb } = regime;
  const { aggressionMult } = scores;
  const lvl = state.unlockLevel || 0;

  let vaultPct, oppPct, explPct;

  if(strProb > 0.65) {
    vaultPct = 1.0; oppPct = 0; explPct = 0;
  } else if(dominant === 'EXPANSION') {
    oppPct   = clamp((0.3 * aggressionMult * expProb), 0.05, 0.3) * (lvl >= 1 ? 1 : 0);
    explPct  = lvl >= 2 ? clamp(0.1 * aggressionMult, 0, 0.1) : 0;
    vaultPct = clamp(1 - oppPct - explPct, 0.6, 0.95);
  } else if(dominant === 'STRESS') {
    vaultPct = 0.95; oppPct = 0; explPct = 0;
  } else {
    vaultPct = 0.87; oppPct = lvl >= 1 ? 0.13 : 0; explPct = 0;
  }

  const total = vaultPct + oppPct + explPct;
  return { vaultPct: vaultPct/total, oppPct: oppPct/total, explPct: explPct/total };
}

// ── PICK TOKEN ───────────────────────────────────────────────────────────────
function pickToken(regime, scores, state) {
  const useTier2 = (state.unlockLevel || 0) >= 2 && regime.expProb > 0.72 && scores.tradability < 0.4;
  const pool = useTier2 ? { ...TIER1_TOKENS, ...TIER2_TOKENS } : TIER1_TOKENS;
  const tier = useTier2 ? 2 : 1;
  const keys = Object.keys(pool);
  const token = keys[Math.floor(Math.random() * keys.length)];
  return { token, mint: pool[token], tier };
}

// ── MONITOR OPEN POSITION ────────────────────────────────────────────────────
async function checkOpenPosition(position, currentCycle) {
  if(!position) return null;

  // Fetch live token price
  try {
    const res = await fetch(`https://price.jup.ag/v6/price?ids=${position.mint}`);
    const d   = await res.json();
    const currentPrice = d?.data?.[position.mint]?.price;
    if(!currentPrice) return null;

    const pnlPct      = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
    const cyclesHeld  = currentCycle - position.entryCycle;
    const maxCycles   = position.tier === 1 ? 18 : 8;
    const cyclesLeft  = maxCycles - cyclesHeld;

    if(currentPrice <= position.backstopPrice) {
      return { action: 'BACKSTOP', pnlPct, currentPrice, cyclesHeld, cyclesLeft };
    }
    if(currentPrice <= position.stopPrice) {
      return { action: 'STOP', pnlPct, currentPrice, cyclesHeld, cyclesLeft };
    }
    if(currentPrice >= position.targetPrice) {
      return { action: 'TARGET', pnlPct, currentPrice, cyclesHeld, cyclesLeft };
    }
    if(cyclesLeft <= 0) {
      return { action: 'TIME-STOP', pnlPct, currentPrice, cyclesHeld, cyclesLeft };
    }
    return { action: 'HOLD', pnlPct, currentPrice, cyclesHeld, cyclesLeft };
  } catch(e) { return null; }
}

// ── FULL CYCLE ───────────────────────────────────────────────────────────────
async function runCycle(state, walletAddress) {
  const d       = await fetchMarketData();
  const regime  = detectRegime(d);
  const scores  = computeScores(d, state);
  const sanity  = computeSanity(regime, scores);
  const alloc   = computeAllocation(regime, scores, state);

  const emergencyTriggered = d.volatility > 0.82;
  const sanityPass = sanity >= 0.38 && regime.confidence >= 0.52 && !emergencyTriggered;

  let walletBalance = null;
  if(walletAddress) walletBalance = await fetchWalletBalance(walletAddress);

  // Check open position
  let positionUpdate = null;
  if(state.openPosition) {
    positionUpdate = await checkOpenPosition(state.openPosition, state.cycleNum);
  }

  // Build result
  const result = {
    cycleNum:       (state.cycleNum || 0) + 1,
    regime,
    scores,
    sanity,
    sanityPass,
    emergencyTriggered,
    alloc,
    marketData:     d,
    walletBalance,
    positionUpdate,
    solPrice:       d.price,
    timestamp:      new Date().toISOString()
  };

  // Determine action
  if(positionUpdate && positionUpdate.action !== 'HOLD') {
    result.action = 'EXIT_NEEDED';
    result.exitReason = positionUpdate.action;
  } else if(sanityPass && regime.dominant === 'EXPANSION' && !state.openPosition) {
    const tokenInfo = pickToken(regime, scores, state);
    const swapSOL   = (walletBalance || state.totalSOL || 0.5) * alloc.oppPct * regime.expProb;
    const stops     = calcStops(1.0, d.volatility, tokenInfo.tier);
    result.action   = 'TRADE_PROPOSED';
    result.proposal = {
      token:      tokenInfo.token,
      mint:       tokenInfo.mint,
      tier:       tokenInfo.tier,
      amountSOL:  +swapSOL.toFixed(4),
      stops,
      jupUrl:     `https://jup.ag/swap/SOL-${tokenInfo.token}`
    };
  } else if(emergencyTriggered) {
    result.action = 'EMERGENCY';
  } else if(!sanityPass) {
    result.action = 'BLOCKED';
  } else {
    result.action = 'STAKE';
  }

  return result;
}

module.exports = { runCycle, fetchWalletBalance, TIER1_TOKENS, SOL_MINT };
