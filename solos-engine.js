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

// ── CLAMP ────────────────────────────────────────────────────────────────────
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ── PRICE HISTORY CACHE ───────────────────────────────────────────────────────
const priceCache = { prices: [] };

// ── REAL MARKET DATA — PHASE 5 ───────────────────────────────────────────────
async function fetchMarketData() {
  try {
    // 1. SOL price + 24h/7d momentum from CoinGecko
    const cgRes = await fetch(
      'https://api.coingecko.com/api/v3/coins/solana?localization=false&tickers=false&community_data=false&developer_data=false',
      { headers: { 'Accept': 'application/json' }, timeout: 8000 }
    );
    const cg = await cgRes.json();
    const market = cg?.market_data;

    if(!market) throw new Error('CoinGecko bad response');

    const price      = market.current_price?.usd || 140;
    const trend24h   = (market.price_change_percentage_24h || 0) / 100;
    const trend7d    = (market.price_change_percentage_7d  || 0) / 100;
    const volume24h  = market.total_volume?.usd || 0;
    const marketCap  = market.market_cap?.usd || 1;
    const volumeRatio = Math.min(volume24h / (marketCap * 0.05), 2.5); // normalised

    // 2. Volatility from price cache (rolling std dev of last 14 prices)
    priceCache.prices.push(price);
    if(priceCache.prices.length > 14) priceCache.prices.shift();
    let volatility = 0.3; // default
    if(priceCache.prices.length >= 4) {
      const mean = priceCache.prices.reduce((a,b)=>a+b,0) / priceCache.prices.length;
      const variance = priceCache.prices.reduce((a,b)=>a+(b-mean)**2,0) / priceCache.prices.length;
      volatility = clamp(Math.sqrt(variance) / mean, 0.05, 0.95);
    }

    // 3. Liquidity depth + spread from Jupiter quote API
    let liquidityDepth = 0.6, spreadScore = 0.7;
    try {
      // Get a small quote to measure real spread/slippage
      const jupRes = await fetch(
        'https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=10000000&slippageBps=50',
        { timeout: 5000 }
      );
      const jup = await jupRes.json();
      if(jup?.outAmount && jup?.inAmount) {
        // Price impact as spread proxy
        const priceImpact = parseFloat(jup.priceImpactPct || 0);
        spreadScore   = clamp(1 - priceImpact * 10, 0.3, 1.0);
        liquidityDepth = clamp(1 - priceImpact * 5, 0.3, 1.0);
      }
    } catch(e) { /* use defaults */ }

    return { price, trend24h, trend7d, volumeRatio, volatility, liquidityDepth, spreadScore, source: 'live' };

  } catch(e) {
    console.log('Live data fetch failed:', e.message, '— using simulation');
    return generateMarketSim();
  }
}

// ── TOKEN PRICES — for position monitoring ───────────────────────────────────
async function fetchTokenPrice(mint) {
  try {
    const res = await fetch(`https://price.jup.ag/v6/price?ids=${mint}`, { timeout: 5000 });
    const d = await res.json();
    return d?.data?.[mint]?.price || null;
  } catch(e) { return null; }
}

// ── PER-TOKEN LIQUIDITY CHECK ────────────────────────────────────────────────
async function fetchTokenLiquidity(mint, amountSOL) {
  try {
    const lamports = Math.floor(amountSOL * 1e9);
    const res = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${mint}&amount=${lamports}&slippageBps=100`,
      { timeout: 5000 }
    );
    const d = await res.json();
    if(d?.priceImpactPct !== undefined) {
      const impact = parseFloat(d.priceImpactPct);
      return {
        tradable: impact < 0.02,      // block if >2% price impact
        priceImpact: impact,
        liquidityScore: clamp(1 - impact * 20, 0, 1)
      };
    }
  } catch(e) {}
  return { tradable: true, priceImpact: 0, liquidityScore: 0.6 };
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

// ── SIMULATION FALLBACK (used when live APIs fail) ───────────────────────────
function generateMarketSim() {
  const s = Math.random();
  let volatility, trend7d, trend24h, volumeRatio, liquidityDepth, spreadScore;
  if(s < 0.40) {
    volatility=0.15+Math.random()*0.30; trend7d=0.05+Math.random()*0.15;
    trend24h=0.01+Math.random()*0.05; volumeRatio=1.1+Math.random()*0.6;
    liquidityDepth=0.6+Math.random()*0.4; spreadScore=0.7+Math.random()*0.3;
  } else if(s < 0.85) {
    volatility=0.25+Math.random()*0.35; trend7d=-0.03+Math.random()*0.06;
    trend24h=-0.02+Math.random()*0.04; volumeRatio=0.7+Math.random()*0.6;
    liquidityDepth=0.4+Math.random()*0.4; spreadScore=0.5+Math.random()*0.4;
  } else {
    volatility=0.55+Math.random()*0.40; trend7d=-0.12+Math.random()*0.06;
    trend24h=-0.06+Math.random()*0.03; volumeRatio=1.3+Math.random()*0.7;
    liquidityDepth=0.2+Math.random()*0.3; spreadScore=0.3+Math.random()*0.3;
  }
  return { price:140, volatility, trend7d, trend24h, volumeRatio, liquidityDepth, spreadScore, source:'simulation' };
}

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

  const currentPrice = await fetchTokenPrice(position.mint);
  if(!currentPrice) {
    console.log('Could not fetch price for', position.token, '— skipping monitor this cycle');
    return null;
  }

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
    result.positionPnl = positionUpdate.pnlPct;
  } else if(sanityPass && regime.dominant === 'EXPANSION' && !state.openPosition) {
    const tokenInfo = pickToken(regime, scores, state);

    // Phase 5: check real token liquidity before proposing
    const swapSOL   = (walletBalance || state.totalSOL || 0.5) * alloc.oppPct * regime.expProb;
    const liquidity = await fetchTokenLiquidity(tokenInfo.mint, swapSOL);

    if(!liquidity.tradable) {
      result.action = 'BLOCKED';
      result.blockReason = `Token ${tokenInfo.token} price impact ${(liquidity.priceImpact*100).toFixed(2)}% — too illiquid`;
    } else {
      // Fetch real current SOL price for stop calculation anchor
      const solPrice  = result.solPrice || 140;
      const stops     = calcStops(solPrice, d.volatility, tokenInfo.tier);
      result.action   = 'TRADE_PROPOSED';
      result.proposal = {
        token:      tokenInfo.token,
        mint:       tokenInfo.mint,
        tier:       tokenInfo.tier,
        amountSOL:  +swapSOL.toFixed(4),
        stops,
        jupUrl:     `https://jup.ag/swap/SOL-${tokenInfo.token}`,
        priceImpact: liquidity.priceImpact,
        dataSource: d.source || 'live'
      };
    }
  } else if(emergencyTriggered) {
    result.action = 'EMERGENCY';
  } else if(!sanityPass) {
    result.action = 'BLOCKED';
    result.blockReason = `Sanity ${Math.round(sanity*100)} below threshold`;
  } else {
    result.action = 'STAKE';
  }

  return result;
}

module.exports = { runCycle, fetchWalletBalance, TIER1_TOKENS, SOL_MINT };
