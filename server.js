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

const STATE_FILE = path.join(__dirname, 'state.json');
function loadState() {
  try { if(fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); } catch(e) {}
  return { cycleNum:0, totalSOL:0.5, startSOL:0.5, consecutiveWins:0, consecutiveLosses:0,
    recoveryMode:false, unlockLevel:2, openPosition:null, history:[], pendingProposal:null,
    paused:false, _cycleRunning:false, tradeLog:[], winRate:null };
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s,null,2)); } catch(e) { console.error('Save failed:',e.message); }
}
let state = loadState();

// INVESTOS BRIDGE
const INVESTOS_URL = 'https://tolulop3.github.io/investos/latest_brief.json';
async function fetchInvestOSMacro() {
  try {
    const r = await fetch(INVESTOS_URL, { signal: AbortSignal.timeout(6000) });
    if(!r.ok) return null;
    const b = await r.json();
    const m = {
      macroRegime:   b.macro?.regime || 'NORMAL',
      marketRegime:  b.market_regime?.regime || 'BULL',
      solConviction: b.crypto?.assets?.['SOL-USD']?.conviction || 0,
      solDirection:  b.crypto?.assets?.['SOL-USD']?.direction || 'NEUTRAL',
      btcConviction: b.crypto?.assets?.['BTC-USD']?.conviction || 0,
      btcDirection:  b.crypto?.assets?.['BTC-USD']?.direction || 'NEUTRAL',
      timestamp:     b.generated_at || null
    };
    console.log(`InvestOS: macro=${m.macroRegime} market=${m.marketRegime} SOL=${m.solDirection}@${m.solConviction}%`);
    return m;
  } catch(e) { console.log('InvestOS unavailable'); return null; }
}

function applyInvestOSOverride(localRegime, inv) {
  if(!inv) return { regime:localRegime, source:'local', note:'InvestOS unavailable' };
  if(inv.macroRegime==='RISK_OFF'||inv.marketRegime==='BEAR')
    return { regime:'STRESS', source:'investos', note:`Macro ${inv.macroRegime} / Market ${inv.marketRegime}` };
  if(localRegime==='EXPANSION'&&inv.macroRegime==='BULL'&&inv.solConviction>=65&&inv.solDirection==='LONG')
    return { regime:'EXPANSION_CONFIRMED', source:'investos', note:`Macro BULL confirmed · SOL ${inv.solConviction}%` };
  if(inv.macroRegime==='CAUTIOUS'&&localRegime==='EXPANSION')
    return { regime:'NEUTRAL', source:'investos', note:`Macro CAUTIOUS downgrades EXPANSION` };
  return { regime:localRegime, source:'local', note:`No conflict · macro=${inv.macroRegime}` };
}

// WIN RATE TRACKER
function logTrade(entry) {
  state.tradeLog = state.tradeLog || [];
  state.tradeLog.push({ ...entry, timestamp:new Date().toISOString() });
  if(state.tradeLog.length>200) state.tradeLog=state.tradeLog.slice(-200);
  recalcWinRate();
}
function recalcWinRate() {
  const closed=(state.tradeLog||[]).filter(t=>t.outcome!==null);
  if(!closed.length){state.winRate=null;return;}
  const wins=closed.filter(t=>t.outcome==='WIN').length;
  state.winRate={total:closed.length,wins,rate:Math.round(wins/closed.length*100)};
}

// JSONBIN SYNC
async function syncToDashboard(lastResult, investos) {
  if(!JSONBIN_KEY||!JSONBIN_BIN) return;
  try {
    const payload = {
      cycleNum:state.cycleNum, totalSOL:state.totalSOL, unlockLevel:state.unlockLevel,
      consecutiveWins:state.consecutiveWins, consecutiveLosses:state.consecutiveLosses,
      recoveryMode:state.recoveryMode, openPosition:state.openPosition, paused:state.paused,
      lastUpdated:new Date().toISOString(),
      lastAction:lastResult?.action||null, lastRegime:lastResult?.regime?.dominant||null,
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
      investos:investos?{macroRegime:investos.macroRegime,marketRegime:investos.marketRegime,
        solConviction:investos.solConviction,solDirection:investos.solDirection,timestamp:investos.timestamp}:null
    };
    const res = await fetch(`${JSONBIN_BASE}/${JSONBIN_BIN}`,{
      method:'PUT', headers:{'Content-Type':'application/json','X-Master-Key':JSONBIN_KEY},
      body:JSON.stringify(payload)
    });
    console.log('JSONBin sync:',res.status);
  } catch(e){console.log('JSONBin failed:',e.message);}
}

// FORMATTERS
function regimeEmoji(r){return(r==='EXPANSION'||r==='EXPANSION_CONFIRMED')?'🟢':r==='STRESS'?'🔴':'🟡';}

function formatCycleAlert(result,inv,override){
  const r=result.regime,s=result.scores;
  return [
    `⚡ *SolOS Cycle ${result.cycleNum}*`,``,
    `${regimeEmoji(override?.regime||r.dominant)} Regime: *${override?.regime||r.dominant}* ${Math.round(r.dominantProb*100)}%`,
    `📊 Confidence: ${Math.round(r.confidence*100)} | Sanity: ${Math.round(result.sanity*100)}`,
    `💧 Tradability: ${Math.round(s.tradability*100)} | Fragility: ${Math.round(s.fragility*100)}`,
    inv?`🌍 Macro: ${inv.macroRegime} · SOL ${inv.solDirection} ${inv.solConviction}%`:`🌍 Macro: unavailable`,
    override?.source==='investos'?`⚡ Override: ${override.note}`:'',
    `💰 Wallet: ${result.walletBalance?result.walletBalance.toFixed(4)+' SOL':'not connected'}`,``,
    `Status: *${result.action}*`
  ].filter(Boolean).join('\n');
}

function formatTradeProposal(result,inv,override){
  const p=result.proposal;
  return [
    `🚀 *TRADE PROPOSED — Cycle ${result.cycleNum}*`,``,
    `SOL → *${p.token}* (Tier ${p.tier})`,`Amount: *${p.amountSOL} SOL*`,``,
    `📉 Stop: -${p.stops.stopPct}%`,`📈 Target: +${p.stops.targetPct}%`,`🛡 Backstop: -${p.stops.backstopPct}%`,``,
    `Regime: ${Math.round(result.regime.expProb*100)}% expansion | Sanity: ${Math.round(result.sanity*100)}/100`,
    inv?`🌍 Macro: ${inv.macroRegime} · SOL ${inv.solConviction}%`:'',
    override?.regime==='EXPANSION_CONFIRMED'?'✅ InvestOS CONFIRMED':'',
    `Signal: ${p.dataSource==='live'?'🟢 live':'🟡 simulated'}`,``,
    `Tap ✅ to approve or ❌ to skip`
  ].filter(Boolean).join('\n');
}

function formatPositionAlert(pos,update){
  const e=update.action==='TARGET'?'✅':update.action==='BACKSTOP'?'🚨':'⚠️';
  return [`${e} *${update.action} — ${pos.token}*`,``,
    `P&L: *${update.pnlPct>=0?'+':''}${update.pnlPct.toFixed(1)}%*`,
    `Entry: ${pos.entryPrice.toFixed(4)} | Now: ${update.currentPrice.toFixed(4)}`,
    `Cycles held: ${update.cyclesHeld}`,``,`Tap ✅ to exit or ❌ to hold`].join('\n');
}

async function send(text,opts={}) {
  try { await bot.sendMessage(CHAT_ID,text,{parse_mode:'Markdown',...opts}); }
  catch(e){console.error('Send failed:',e.message);}
}

const APPROVE_KB={inline_keyboard:[[{text:'✅ Approve',callback_data:'approve'},{text:'❌ Skip',callback_data:'skip'}]]};
const EXIT_KB={inline_keyboard:[[{text:'✅ Exit now',callback_data:'exit_approve'},{text:'❌ Hold',callback_data:'exit_skip'}]]};

// MAIN CYCLE
async function executeCycle(manual=false) {
  if(state.paused&&!manual) return;
  if(state._cycleRunning){console.log('Already running — skipped');return;}
  state._cycleRunning=true;
  console.log(`Running cycle ${(state.cycleNum||0)+1}...`);
  try {
    const investos = await fetchInvestOSMacro();
    const result   = await runCycle(state, WALLET_ADDR);
    state.cycleNum = result.cycleNum;
    const override = applyInvestOSOverride(result.regime.dominant, investos);
    result.regime.dominant = override.regime;

    if((override.regime==='STRESS'||override.regime==='NEUTRAL')&&result.action==='TRADE_PROPOSED'){
      result.action='BLOCKED'; result.blockReason=override.note;
      console.log('Trade blocked by InvestOS:',override.note);
    }

    if(result.positionUpdate&&result.action==='EXIT_NEEDED'){
      state.pendingProposal={type:'EXIT',result};
      saveState(state);
      await send(formatPositionAlert(state.openPosition,result.positionUpdate),{reply_markup:EXIT_KB});
      await syncToDashboard(result,investos);
      return;
    }
    if(result.action==='TRADE_PROPOSED'){
      state.pendingProposal={type:'ENTRY',result,investos,override};
      logTrade({cycle:state.cycleNum,regime:override.regime,investosRegime:investos?.macroRegime||null,
        solConviction:investos?.solConviction||null,action:'PROPOSED',token:result.proposal.token,
        amountSOL:result.proposal.amountSOL,approved:null,outcome:null,exitReason:null,pnlPct:null});
      saveState(state);
      await send(formatTradeProposal(result,investos,override),{reply_markup:APPROVE_KB});
      await syncToDashboard(result,investos);
      return;
    }
    if(result.action==='EMERGENCY'){
      await send(`🚨 *EMERGENCY — Cycle ${result.cycleNum}*\nVolatility spike. Vault only.`);
      if(state.openPosition){state.openPosition=null;saveState(state);}
      await syncToDashboard(result,investos);
      return;
    }
    if(manual||result.cycleNum%4===0) await send(formatCycleAlert(result,investos,override));
    if(result.action==='STAKE') state.totalSOL=(state.totalSOL||0.5)+(state.totalSOL||0.5)*0.000015;
    state.history=state.history||[];
    state.history.push({cycle:result.cycleNum,action:result.action,regime:override.regime,
      sanity:Math.round(result.sanity*100),investosMacro:investos?.macroRegime||null,timestamp:new Date().toISOString()});
    if(state.history.length>50) state.history=state.history.slice(-50);
    saveState(state);
    await syncToDashboard(result,investos);
  } catch(e){
    console.error('Cycle error:',e.message);
    if(manual) await send(`❌ Cycle error: ${e.message}`);
  } finally { state._cycleRunning=false; }
}

// CALLBACKS
bot.on('callback_query', async(query)=>{
  const data=query.data,pending=state.pendingProposal;
  await bot.answerCallbackQuery(query.id);
  if(!pending){await send('No pending proposal.');return;}
  if(data==='approve'&&pending.type==='ENTRY'){
    const p=pending.result.proposal;
    const {fetchTokenPrice}=require('./solos-engine');
    let entryPrice=1.0;
    try{const lp=await fetchTokenPrice(p.mint);if(lp)entryPrice=lp;}catch(e){}
    state.openPosition={token:p.token,mint:p.mint,tier:p.tier,entryPrice,entrySOL:p.amountSOL,
      stopPrice:entryPrice*(1-p.stops.stopPct/100),targetPrice:entryPrice*(1+p.stops.targetPct/100),
      backstopPrice:entryPrice*(1-p.stops.backstopPct/100),entryCycle:state.cycleNum,entryTime:Date.now()};
    const li=(state.tradeLog||[]).findLastIndex(t=>t.cycle===state.cycleNum&&t.action==='PROPOSED');
    if(li>=0){state.tradeLog[li].approved=true;state.tradeLog[li].entryPrice=entryPrice;}
    state.pendingProposal=null;saveState(state);
    await syncToDashboard(null,null);
    await send(`✅ *Approved*\n\n${p.amountSOL} SOL → ${p.token}\nEntry: $${entryPrice.toFixed(6)}\nStop: $${state.openPosition.stopPrice.toFixed(6)} (-${p.stops.stopPct}%)\nTarget: $${state.openPosition.targetPrice.toFixed(6)} (+${p.stops.targetPct}%)\n\n${p.jupUrl}`);
  }
  else if(data==='skip'&&pending.type==='ENTRY'){
    const li=(state.tradeLog||[]).findLastIndex(t=>t.cycle===state.cycleNum&&t.action==='PROPOSED');
    if(li>=0)state.tradeLog[li].approved=false;
    state.pendingProposal=null;saveState(state);
    await send(`⏭ Skipped — next cycle in 15 min.`);
  }
  else if(data==='exit_approve'&&pending.type==='EXIT'){
    const pos=state.openPosition;
    const li=(state.tradeLog||[]).findLastIndex(t=>t.token===pos.token&&t.approved===true);
    if(li>=0){const pnl=pending.result.positionUpdate?.pnlPct||0;
      state.tradeLog[li].outcome=pnl>=0?'WIN':'LOSS';
      state.tradeLog[li].exitReason=pending.result.positionUpdate?.action;
      state.tradeLog[li].pnlPct=pnl;recalcWinRate();}
    state.openPosition=null;state.pendingProposal=null;
    state.consecutiveLosses=0;state.recoveryMode=false;
    saveState(state);
    await send(`✅ *Exit approved*\n\nhttps://jup.ag/swap/${pos.token}-SOL`);
  }
  else if(data==='exit_skip'&&pending.type==='EXIT'){
    state.pendingProposal=null;saveState(state);
    await send(`⏸ Holding. Monitoring continues.`);
  }
});

// COMMANDS
bot.onText(/\/start/,async()=>await send(`👋 *SolOS + InvestOS Bridge Active*\n\n/status /run /position /winrate /pause /resume /balance /setup`));
bot.onText(/\/status/,async()=>{
  const bal=WALLET_ADDR?await fetchWalletBalance(WALLET_ADDR):null;
  const inv=await fetchInvestOSMacro();
  const pos=state.openPosition;
  await send([`📊 *SolOS Status*`,``,`Cycles: ${state.cycleNum}`,
    `Wallet: ${bal?bal.toFixed(4)+' SOL':'n/a'}`,`Open position: ${pos?pos.token:'none'}`,
    `Recovery: ${state.recoveryMode?'YES':'no'}`,`Auto-cycles: ${state.paused?'PAUSED':'RUNNING'}`,
    `Win rate: ${state.winRate?state.winRate.rate+'% ('+state.winRate.total+' trades)':'no data yet'}`,``,
    `🌍 InvestOS macro: ${inv?.macroRegime||'unavailable'}`,
    `SOL signal: ${inv?.solDirection||'—'} ${inv?.solConviction||0}%`].join('\n'));
});
bot.onText(/\/run/,async()=>{await send('⚡ Running manual cycle...');await executeCycle(true);});
bot.onText(/\/winrate/,async()=>{
  if(!state.winRate){await send('No closed trades yet.');return;}
  const wr=state.winRate;
  const byRegime={};
  (state.tradeLog||[]).filter(t=>t.outcome).forEach(t=>{
    byRegime[t.regime]=byRegime[t.regime]||{wins:0,total:0};
    byRegime[t.regime].total++;if(t.outcome==='WIN')byRegime[t.regime].wins++;});
  const lines=Object.entries(byRegime).map(([r,v])=>`  ${r}: ${Math.round(v.wins/v.total*100)}% (${v.total})`);
  await send([`📈 *Win Rate*`,``,`Overall: ${wr.rate}% (${wr.wins}W/${wr.total-wr.wins}L)`,``,`By regime:`,...lines].join('\n'));
});
bot.onText(/\/position/,async()=>{
  if(!state.openPosition){await send('No open position.');return;}
  const p=state.openPosition;
  await send(`📈 *Open Position*\n\n${p.token} (Tier ${p.tier})\nEntry: $${p.entryPrice.toFixed(6)}\nStop: $${p.stopPrice.toFixed(6)}\nTarget: $${p.targetPrice.toFixed(6)}`);
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
    if(binId)await send(`✅ JSONBin created!\n\nBin ID: \`${binId}\`\n\nAdd to Render env:\nJSONBIN_BIN = ${binId}`);
    else await send('❌ Failed: '+JSON.stringify(d).slice(0,200));
  }catch(e){await send('❌ JSONBin error: '+e.message);}
});

// CRON
cron.schedule('*/15 * * * *',()=>executeCycle(false));

// HTTP SERVER + WEBHOOK
const server=http.createServer(async(req,res)=>{
  if(req.method==='POST'&&req.url===WEBHOOK_PATH){
    let body='';
    req.on('data',chunk=>body+=chunk);
    req.on('end',()=>{
      try{bot.processUpdate(JSON.parse(body));}catch(e){console.log('Webhook parse error:',e.message);}
      res.writeHead(200).end('ok');
    });
    return;
  }
  if(req.url==='/health'){
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({status:'running',cycle:state.cycleNum,uptime:process.uptime(),
      paused:state.paused,openPosition:state.openPosition?.token||null,winRate:state.winRate||null}));
    return;
  }
  res.writeHead(200).end('SolOS Phase 4');
});

server.listen(PORT,async()=>{
  console.log(`SolOS Phase 4 listening on port ${PORT}`);
  if(RENDER_URL){
    const webhookUrl=`${RENDER_URL}${WEBHOOK_PATH}`;
    try{await bot.setWebHook(webhookUrl);console.log('Webhook set:',webhookUrl);}
    catch(e){console.log('Webhook set failed:',e.message);}
  } else {
    console.log('No RENDER_EXTERNAL_URL set — add to Render env vars');
  }
  setTimeout(async()=>{
    await send(`🚀 *SolOS Phase 4 + InvestOS Bridge*\nWebhook mode · No polling · Cycles every 15 min\nWallet: ${WALLET_ADDR?WALLET_ADDR.slice(0,6)+'...'+WALLET_ADDR.slice(-4):'not set'}\n\n/status to check`);
    setTimeout(()=>executeCycle(false),3000);
  },2000);
});
