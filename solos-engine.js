'use strict';

const fetch = require('node-fetch');

const HELIUS = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

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
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ── PRICE CACHE — persists last valid data across failed fetches ───────────────
let priceCache = {
  prices: [],
  lastValid: null,      // { price, trend24h, trend7d, volumeRatio, timestamp }
  lastValidAge: null
};

function getCachedFallback() {
  if(!priceCache.lastValid) return null;
  const ageMinutes = (Date.now() - priceCache.lastValid.timestamp) / 60000;
  if(ageMinutes > 30) {
    console.log(`Price cache too stale (${Math.round(ageMinutes)}min) — using simulation`);
    return null;
  }
  console.log(`Using cached price data (${Math.round(ageMinutes)}min old)`);
  return { ...priceCache.lastValid, source:'cached', cacheAgeMin:Math.round(ageMinutes) };
}

// ── MULTI-PROVIDER PRICE FETCH ────────────────────────────────────────────────
// Provider cooldown tracker — prevents hammering after 429
const providerCooldowns = {};
function isProviderCoolingDown(name) {
  const until = providerCooldowns[name];
  if(until && Date.now() < until) {
    console.log(`[PRICE] ${name} in cooldown for ${Math.round((until-Date.now())/1000)}s`);
    return true;
  }
  return false;
}
function setCooldown(name, minutes=5) {
  providerCooldowns[name] = Date.now() + minutes*60000;
  console.log(`[PRICE] ${name} cooling down for ${minutes}min`);
}

async function fetchSOLPrice() {
  const errors = [];

  // Provider 1: Binance (most reliable, no auth needed for public price)
  if(!isProviderCoolingDown('binance')) {
    try {
      const controller = new AbortController();
      const t = setTimeout(()=>controller.abort(), 5000);
      const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
        { signal:controller.signal });
      clearTimeout(t);
      if(r.status===429) { setCooldown('binance',10); errors.push('binance: 429'); }
      else if(r.ok) {
        const d = await r.json();
        if(d?.price) {
          const price = parseFloat(d.price);
          console.log(`[PRICE] binance: $${price}`);
          return { price, trend24h:0, trend7d:0, source:'binance' };
        }
      } else { errors.push(`binance: HTTP ${r.status}`); }
    } catch(e) { errors.push(`binance: ${e.message}`); }
  }

  // Provider 2: Coinbase (public, no auth)
  if(!isProviderCoolingDown('coinbase')) {
    try {
      const controller = new AbortController();
      const t = setTimeout(()=>controller.abort(), 5000);
      const r = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot',
        { headers:{'Accept':'application/json'}, signal:controller.signal });
      clearTimeout(t);
      if(r.status===429) { setCooldown('coinbase',10); errors.push('coinbase: 429'); }
      else if(r.ok) {
        const d = await r.json();
        const price = parseFloat(d?.data?.amount);
        if(price) {
          console.log(`[PRICE] coinbase: $${price}`);
          return { price, trend24h:0, trend7d:0, source:'coinbase' };
        }
      } else { errors.push(`coinbase: HTTP ${r.status}`); }
    } catch(e) { errors.push(`coinbase: ${e.message}`); }
  }

  // Provider 3: CoinGecko simple (with cooldown on 429)
  if(!isProviderCoolingDown('coingecko')) {
    try {
      const controller = new AbortController();
      const t = setTimeout(()=>controller.abort(), 6000);
      const r = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true',
        { headers:{'Accept':'application/json'}, signal:controller.signal });
      clearTimeout(t);
      if(r.status===429) { setCooldown('coingecko',15); errors.push('coingecko: 429'); }
      else if(r.ok) {
        const d = await r.json();
        if(d?.solana?.usd) {
          console.log(`[PRICE] coingecko: $${d.solana.usd}`);
          return { price:d.solana.usd, trend24h:(d.solana.usd_24h_change||0)/100, trend7d:0, source:'coingecko' };
        }
      } else { errors.push(`coingecko: HTTP ${r.status}`); }
    } catch(e) { errors.push(`coingecko: ${e.message}`); }
  }

  // Provider 4: Jupiter (updated endpoint)
  if(!isProviderCoolingDown('jupiter')) {
    try {
      const controller = new AbortController();
      const t = setTimeout(()=>controller.abort(), 5000);
      const r = await fetch(
        `https://price.jup.ag/v4/price?ids=${SOL_MINT}`,
        { signal:controller.signal });
      clearTimeout(t);
      if(r.status===429) { setCooldown('jupiter',10); errors.push('jupiter: 429'); }
      else if(r.ok) {
        const d = await r.json();
        const p = d?.data?.[SOL_MINT]?.price;
        if(p) { console.log(`[PRICE] jupiter: $${p}`); return { price:p, trend24h:0, trend7d:0, source:'jupiter' }; }
        else { errors.push('jupiter: no price in response'); }
      } else { errors.push(`jupiter: HTTP ${r.status}`); }
    } catch(e) { errors.push(`jupiter: ${e.message}`); }
  }

  console.log('[PRICE] All providers failed:');
  errors.forEach(e => console.log('  >', e));
  return null;
}
// ── MAIN MARKET DATA FUNCTION ─────────────────────────────────────────────────
async function fetchMarketData() {
  const priceData = await fetchSOLPrice();

  if(!priceData) {
    const cached = getCachedFallback();
    if(cached) {
      console.log(`[PRICE] Using cache (${cached.cacheAgeMin}min old)`);
      return buildMarketData(cached.price, cached.trend24h, cached.trend7d, cached.volumeRatio||1.0, 'cached');
    }
    // No live data, no cache — mark as unavailable, do NOT simulate
    console.log('[PRICE] UNAVAILABLE — trading disabled this cycle');
    return { price:null, trend24h:0, trend7d:0, volumeRatio:1, volatility:0.3,
      liquidityDepth:0.6, spreadScore:0.7, source:'unavailable', tradingDisabled:true };
  }

  const price     = priceData.price;
  const trend24h  = priceData.trend24h || 0;
  const trend7d   = priceData.trend7d  || (priceCache.lastValid?.trend7d || 0);
  const volumeRatio = priceData.volume24h && priceData.marketCap
    ? Math.min(priceData.volume24h / (priceData.marketCap * 0.05), 2.5)
    : priceCache.lastValid?.volumeRatio || 1.0;

  priceCache.lastValid = { price, trend24h, trend7d, volumeRatio, timestamp:Date.now() };
  return buildMarketData(price, trend24h, trend7d, volumeRatio, priceData.source);
}

function buildMarketData(price, trend24h, trend7d, volumeRatio, source) {
  // Update rolling price cache for volatility
  priceCache.prices.push(price);
  if(priceCache.prices.length > 14) priceCache.prices.shift();

  let volatility = 0.3;
  if(priceCache.prices.length >= 4) {
    const mean = priceCache.prices.reduce((a,b)=>a+b,0)/priceCache.prices.length;
    const variance = priceCache.prices.reduce((a,b)=>a+(b-mean)**2,0)/priceCache.prices.length;
    volatility = clamp(Math.sqrt(variance)/mean, 0.05, 0.95);
  }

  // Jupiter liquidity check
  let liquidityDepth=0.6, spreadScore=0.7;
  // (async liquidity check runs separately — not blocking main data)

  console.log(`Market data: SOL $${price} | 24h ${(trend24h*100).toFixed(1)}% | vol ${(volatility*100).toFixed(1)}% | source: ${source}`);
  return { price, trend24h, trend7d, volumeRatio, volatility, liquidityDepth, spreadScore, source };
}

// ── TOKEN PRICES — for position monitoring ───────────────────────────────────
// Token symbol to CoinGecko ID map
const COINGECKO_IDS = {
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'bonk',
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 'dogwifcoin',
  'jtojtomepa8bdiya4a52nd8bvitbchlba5hmbyl88gk': 'jito-governance-token',
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 'raydium',
  'HZ1JovNiVvGrG4vGbxFoQZyFgCAABGg5Q6MrC2N3Mhkm': 'pyth-network'
};

async function fetchTokenPrice(mint) {
  // Provider 1: Jupiter v6 price API
  try {
    const controller = new AbortController();
    const t = setTimeout(()=>controller.abort(), 5000);
    const res = await fetch(`https://price.jup.ag/v6/price?ids=${mint}`,
      { signal:controller.signal });
    clearTimeout(t);
    if(res.ok) {
      const d = await res.json();
      const price = d?.data?.[mint]?.price;
      if(price) { console.log(`[TOKEN] ${mint.slice(0,8)}: $${price} (jupiter_v6)`); return price; }
    } else { console.log(`[TOKEN] jupiter_v6: HTTP ${res.status}`); }
  } catch(e) { console.log(`[TOKEN] jupiter_v6 failed: ${e.message}`); }

  // Provider 2: Jupiter v4
  try {
    const controller = new AbortController();
    const t = setTimeout(()=>controller.abort(), 5000);
    const res = await fetch(`https://price.jup.ag/v4/price?ids=${mint}`,
      { signal:controller.signal });
    clearTimeout(t);
    if(res.ok) {
      const d = await res.json();
      const price = d?.data?.[mint]?.price;
      if(price) { console.log(`[TOKEN] ${mint.slice(0,8)}: $${price} (jupiter_v4)`); return price; }
    } else { console.log(`[TOKEN] jupiter_v4: HTTP ${res.status}`); }
  } catch(e) { console.log(`[TOKEN] jupiter_v4 failed: ${e.message}`); }

  // Provider 3: CoinGecko by token ID
  const geckoId = COINGECKO_IDS[mint];
  if(geckoId && !isProviderCoolingDown('coingecko_token')) {
    try {
      const controller = new AbortController();
      const t = setTimeout(()=>controller.abort(), 6000);
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${geckoId}&vs_currencies=usd`,
        { headers:{'Accept':'application/json'}, signal:controller.signal });
      clearTimeout(t);
      if(res.status===429) { setCooldown('coingecko_token',15); }
      else if(res.ok) {
        const d = await res.json();
        const price = d?.[geckoId]?.usd;
        if(price) { console.log(`[TOKEN] ${geckoId}: $${price} (coingecko)`); return price; }
      } else { console.log(`[TOKEN] coingecko: HTTP ${res.status}`); }
    } catch(e) { console.log(`[TOKEN] coingecko failed: ${e.message}`); }
  }

  // Provider 4: Birdeye public
  try {
    const controller = new AbortController();
    const t = setTimeout(()=>controller.abort(), 5000);
    const res = await fetch(`https://public-api.birdeye.so/defi/price?address=${mint}`,
      { headers:{'X-API-KEY':'public','x-chain':'solana'}, signal:controller.signal });
    clearTimeout(t);
    if(res.ok) {
      const d = await res.json();
      const price = d?.data?.value;
      if(price) { console.log(`[TOKEN] ${mint.slice(0,8)}: $${price} (birdeye)`); return price; }
    } else { console.log(`[TOKEN] birdeye: HTTP ${res.status}`); }
  } catch(e) { console.log(`[TOKEN] birdeye failed: ${e.message}`); }

  console.log(`[TOKEN] all providers failed for ${mint.slice(0,8)}`);
  return null;
}

// ── PER-TOKEN LIQUIDITY CHECK ────────────────────────────────────────────────
async function fetchTokenLiquidity(mint, amountSOL) {
  try {
    const lamports = Math.floor(amountSOL * 1e9);
    const controller = new AbortController();
    const t = setTimeout(()=>controller.abort(), 5000);
    const res = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${lamports}&slippageBps=100`,
      { signal:controller.signal }
    );
    clearTimeout(t);
    const d = await res.json();
    if(d?.priceImpactPct !== undefined) {
      const impact = parseFloat(d.priceImpactPct);
      return {
        tradable: impact < 0.02,
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

module.exports = { runCycle, fetchWalletBalance, fetchTokenPrice, TIER1_TOKENS, TIER2_TOKENS, SOL_MINT };
