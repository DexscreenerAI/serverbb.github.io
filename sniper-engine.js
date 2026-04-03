// ═══════════════════════════════════════════════════════════════
// SNIPER ENGINE - Server-side memecoin trading bot
// ═══════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const fN = n => n >= 1e9 ? (n/1e9).toFixed(2)+'B' : n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : n.toFixed(0);
const fP = p => p < 0.0001 ? p.toFixed(8) : p < 0.01 ? p.toFixed(6) : p < 1 ? p.toFixed(4) : p.toFixed(2);
const getTime = () => new Date().toLocaleTimeString('en-US', { hour12: false });

const KEYWORDS = [
  'moon','pump','gem','degen','pepe','wojak','based','chad','giga',
  'trump','elon','musk','cat','dog','frog','inu','shib','doge','bonk','wif',
  'ai','gpt','agent','bot','meme','nft','sol','eth','btc',
  'rich','gold','diamond','rocket','lambo','king','god',
  'alpha','sigma','safe','fire','burn','moon','mars','cope','wagmi'
];

function createSniperEngine(options = {}) {
  const {
    broadcastFn = () => {},
    dataDir = './data',
    aiApiUrl = 'https://dexscreener-telegram-bot-production.up.railway.app/api/chat'
  } = options;

  // ═══ STATE ═══
  const INITIAL_BALANCE = 10000;
  const POSITION_SIZE = 100;
  const MIN_SCORE = 80;
  const CHAINS = ['solana'];

  let balance = INITIAL_BALANCE;
  let totalPnL = 0, securedPnL = 0, totalTrades = 0, wins = 0;
  let bestTrade = 0, worstTrade = 0;
  let positions = [], history = [], logs = [];
  let isRunning = false;
  let scannedTotal = 0, oppsTotal = 0, lastScanTime = null;
  let scanInterval = null, updateInterval = null, momentumInterval = null;
  let saveTimeout = null;

  // Cache
  const analyzedCache = new Map();
  const CACHE_DURATION = 20 * 60 * 1000;
  let lastCacheClear = Date.now();

  function getCached(addr) {
    if (Date.now() - lastCacheClear > 30 * 60 * 1000) { analyzedCache.clear(); lastCacheClear = Date.now(); return null; }
    const c = analyzedCache.get(addr);
    return (c && Date.now() - c.ts < CACHE_DURATION) ? c.val : null;
  }
  function setCache(addr, val) {
    analyzedCache.set(addr, { val, ts: Date.now() });
    if (analyzedCache.size > 1500) {
      const entries = [...analyzedCache.entries()].sort((a,b) => a[1].ts - b[1].ts).slice(0, 400);
      entries.forEach(([k]) => analyzedCache.delete(k));
    }
  }

  // ═══ LOGGING ═══
  function addLog(icon, text) {
    const entry = { time: getTime(), icon, text };
    logs.unshift(entry);
    if (logs.length > 100) logs.pop();
    broadcastFn('LOG', 'NEW', entry);
    console.log(`[SNIPER] ${icon} ${text.replace(/<[^>]*>/g, '')}`);
  }

  // ═══ AI ═══
  async function askAI(prompt) {
    try {
      const res = await fetch(aiApiUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: prompt }),
        signal: AbortSignal.timeout(15000)
      });
      const data = await res.json();
      return data.response || data.message || '';
    } catch (e) { return ''; }
  }

  // ═══ PERSISTENCE ═══
  const STATE_FILE = path.join(dataDir, 'sniper_state.json');

  function saveState() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      try {
        const data = { balance, totalPnL, securedPnL, totalTrades, wins, bestTrade, worstTrade, positions, history: history.slice(0, 200) };
        fs.writeFileSync(STATE_FILE, JSON.stringify(data), 'utf-8');
      } catch (e) { console.warn('Sniper save error:', e.message); }
    }, 2000);
  }

  function loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        balance = data.balance || INITIAL_BALANCE;
        totalPnL = data.totalPnL || 0; securedPnL = data.securedPnL || 0;
        totalTrades = data.totalTrades || 0; wins = data.wins || 0;
        bestTrade = data.bestTrade || 0; worstTrade = data.worstTrade || 0;
        positions = data.positions || []; history = data.history || [];
        console.log(`[SNIPER] State loaded: $${balance.toFixed(0)} balance, ${positions.length} positions, ${history.length} history`);
      }
    } catch (e) { console.warn('Sniper load error:', e.message); }
  }

  // ═══ SCORING ═══
  function calculateScore(pair) {
    const mc = parseFloat(pair.marketCap) || 0;
    const liq = parseFloat(pair.liquidity?.usd) || 0;
    const vol24h = parseFloat(pair.volume?.h24) || 0;
    const chg5m = parseFloat(pair.priceChange?.m5) || 0;
    const chg1h = parseFloat(pair.priceChange?.h1) || 0;
    const chg6h = parseFloat(pair.priceChange?.h6) || 0;
    const chg24h = parseFloat(pair.priceChange?.h24) || 0;
    const buys5m = pair.txns?.m5?.buys || 0, sells5m = pair.txns?.m5?.sells || 0;
    const buys1h = pair.txns?.h1?.buys || 0, sells1h = pair.txns?.h1?.sells || 0;
    const buys = pair.txns?.h24?.buys || 0, sells = pair.txns?.h24?.sells || 0;
    const total5m = buys5m + sells5m, total1h = buys1h + sells1h, total = buys + sells;
    const buyRatio5m = total5m > 0 ? (buys5m / total5m) * 100 : 50;
    const buyRatio1h = total1h > 0 ? (buys1h / total1h) * 100 : 50;
    const symbol = pair.baseToken?.symbol || '';
    const sourceBoost = pair._boost || 0;
    let score = 20 + sourceBoost;

    // Token name
    if (symbol.length < 2) return 0;
    if (symbol.length < 3) score -= 25;
    if (/^\d+$/.test(symbol)) score -= 30;
    if (/[^\w\s]/.test(symbol)) score -= 10;

    // Market cap
    if (mc >= 200000 && mc <= 1000000) score += 25;
    else if (mc >= 30000 && mc < 50000) score += 12;
    else if (mc >= 50000 && mc < 100000) score -= 5;
    else if (mc >= 100000 && mc < 200000) score -= 3;
    else if (mc > 1000000 && mc <= 2000000) score += 5;
    else if (mc > 2000000) score -= 5;
    else if (mc >= 10000 && mc < 30000) score += 8;
    else if (mc < 10000) score -= 20;

    // Buy ratio 5m (inverted)
    if (buyRatio5m >= 80) score -= 12;
    else if (buyRatio5m >= 60) score -= 5;
    else if (buyRatio5m >= 40) score += 8;
    else if (total5m >= 5) score += 15;
    if (buyRatio1h >= 85) score -= 8;
    else if (buyRatio1h >= 40 && buyRatio1h < 60) score += 5;

    // Liquidity
    const liqRatio = mc > 0 ? (liq / mc) * 100 : 0;
    if (liq < 10000) return 0;
    if (liq < 15000) score -= 25;
    else if (liq < 20000) score -= 15;
    else if (liq < 30000) score -= 8;
    if (liq >= 50000) score += 10;
    if (liqRatio >= 8 && liqRatio <= 20) score += 10;
    else if (liqRatio >= 5 && liqRatio <= 25) score += 5;
    else if (liqRatio < 3) score -= 15;

    // Momentum
    if (chg5m > 5 && chg5m < 25) score += 10;
    if (chg5m >= 25 && chg5m < 50) score += 5;
    if (chg1h > 10 && chg1h < 60) score += 8;
    if (chg5m > 60) score -= 15;
    if (chg1h > 120) score -= 12;
    if (chg5m < -20) score -= 12;
    if (chg1h < -30) score -= 10;

    // Volume
    const volRatio = mc > 0 ? (vol24h / mc) : 0;
    if (volRatio > 0.3) score += 8;
    if (volRatio > 0.6) score += 5;
    if (volRatio > 1) score += 3;
    if (total5m >= 8 && total5m <= 30) score += 8;
    if (total1h >= 30 && total1h <= 150) score += 5;
    if (total >= 100) score += 3;

    // Trend
    if (chg5m > 0 && chg1h > 0) score += 5;
    if (chg5m > 0 && chg1h > 0 && chg6h > 0) score += 5;
    if (chg24h < -15 && chg1h > 15) score += 8;

    // Honeypot
    if (sells5m === 0 && buys5m > 10) score -= 50;
    if (sells1h === 0 && buys1h > 20) score -= 40;
    if (buyRatio5m >= 99 && sells5m === 0 && buys5m > 5) score -= 30;
    if (buyRatio5m === 100 && buyRatio1h === 100 && sells5m === 0 && sells1h === 0) return 0;

    return Math.min(100, Math.max(0, Math.round(score)));
  }

  // ═══ TRADE EXECUTION ═══
  function executeTrade(pair, score, tradeType = 'QUICK') {
    if (balance < POSITION_SIZE) return;
    const symbol = pair.baseToken?.symbol || 'UNKNOWN';
    const chain = pair.chainId;
    const address = pair.baseToken?.address;
    const pairAddress = pair.pairAddress;
    const entryPrice = parseFloat(pair.priceUsd) || 0;
    if (entryPrice === 0 || !address) return;
    if (positions.find(p => p.address === address || p.symbol === symbol)) return;
    if (history.find(h => h.address === address)) return;

    // Honeypot check
    const b5 = pair.txns?.m5?.buys || 0, s5 = pair.txns?.m5?.sells || 0;
    const b1 = pair.txns?.h1?.buys || 0, s1 = pair.txns?.h1?.sells || 0;
    if (s5 === 0 && s1 === 0 && b5 > 5 && b1 > 10) {
      addLog('🍯', `HONEYPOT $${symbol} — 0 sells, skip`);
      return;
    }

    const isLong = tradeType === 'LONG';
    const pos = {
      id: Date.now(), symbol, chain, address, pairAddress,
      entryPrice, currentPrice: entryPrice,
      entryMarketCap: parseFloat(pair.marketCap) || 0,
      entryLiquidity: parseFloat(pair.liquidity?.usd) || 0,
      entryVolume24h: parseFloat(pair.volume?.h24) || 0,
      entryBuyRatio5m: (b5 + s5) > 0 ? (b5 / (b5 + s5) * 100) : 50,
      entryChg5m: parseFloat(pair.priceChange?.m5) || 0,
      entryChg1h: parseFloat(pair.priceChange?.h1) || 0,
      initialSize: POSITION_SIZE, currentSize: POSITION_SIZE,
      score, tradeType,
      pnl: 0, pnlPct: 0, highestPnlPct: 0,
      entryTime: Date.now(), extended: 0,
      trailingActivated: false, trailingHigh: 0, currentTrailDistance: 20,
      dcaLevel: 0, dcaSecured: 0, isMoonBag: false,
      stopLoss: 25, lastBuyRatio: 50, consecutiveBadMomentum: 0,
      maxHold: isLong ? 360 : 20,
      maxExtend: isLong ? 3 : 1,
      label: isLong ? '🌙 LONG' : '⚡ QUICK'
    };

    positions.push(pos);
    balance -= POSITION_SIZE;
    addLog('🎯', `${pos.label} $${symbol} @ $${fP(entryPrice)} — Score: ${score}`);
    broadcastFn('TRADE', 'OPEN', { position: pos });
    broadcastState();
    saveState();
  }

  // ═══ PARTIAL SELL (DCA) ═══
  function partialSell(pos, sellPct, reason, level) {
    const sellAmt = pos.currentSize * (sellPct / 100);
    const pnlForSold = sellAmt * (pos.pnlPct / 100);
    pos.currentSize -= sellAmt;
    pos.dcaSecured += pnlForSold;
    pos.dcaLevel = level;
    securedPnL += pnlForSold;
    balance += sellAmt + pnlForSold;
    addLog('💰', `DCA ${level} $${pos.symbol} — Sold ${sellPct}% — Secured +$${pnlForSold.toFixed(2)}`);
    broadcastFn('TRADE', 'DCA', { symbol: pos.symbol, dcaLevel: level, secured: pnlForSold });
    if (level === 3 && pos.currentSize > 0) {
      pos.isMoonBag = true; pos.tradeType = 'MOON'; pos.label = '🌕 MOON';
      addLog('🌕', `MOON BAG $${pos.symbol} — $${pos.currentSize.toFixed(0)} rides free!`);
    }
  }

  // ═══ CLOSE TRADE ═══
  function closeTrade(pos, reason) {
    if (!positions.find(p => p.id === pos.id)) return;
    const remainingPnl = pos.currentSize * (pos.pnlPct / 100);
    const finalPnl = remainingPnl + pos.dcaSecured;
    positions = positions.filter(p => p.id !== pos.id);
    totalPnL += finalPnl;
    balance += pos.currentSize + remainingPnl;
    totalTrades++;
    if (finalPnl > 0) { wins++; if (finalPnl > bestTrade) bestTrade = finalPnl; }
    else { if (finalPnl < worstTrade) worstTrade = finalPnl; }

    const holdMin = Math.floor((Date.now() - pos.entryTime) / 60000);
    history.unshift({
      symbol: pos.symbol, address: pos.address, chain: pos.chain,
      tradeType: pos.tradeType, score: pos.score,
      entryPrice: pos.entryPrice, exitPrice: pos.currentPrice,
      pnl: finalPnl, pnlPct: pos.pnlPct, highestPnlPct: pos.highestPnlPct,
      dcaSecured: pos.dcaSecured, dcaLevel: pos.dcaLevel,
      trailingActivated: pos.trailingActivated, trailingHigh: pos.trailingHigh,
      reason, closeTime: Date.now(), holdMin
    });
    if (history.length > 200) history = history.slice(0, 200);

    const icon = finalPnl >= 0 ? '✅' : '❌';
    const dcaInfo = pos.dcaSecured > 0 ? ` (DCA: +$${pos.dcaSecured.toFixed(2)})` : '';
    addLog(icon, `${reason} $${pos.symbol} — ${finalPnl >= 0 ? '+' : ''}$${finalPnl.toFixed(2)}${dcaInfo} — ${holdMin}min`);
    broadcastFn('TRADE', 'CLOSE', { symbol: pos.symbol, reason, pnl: finalPnl, pnlPct: pos.pnlPct });
    broadcastState();
    saveState();
  }

  // ═══ UPDATE POSITIONS ═══
  async function updatePositions() {
    if (positions.length === 0) return;
    for (let i = positions.length - 1; i >= 0; i--) {
      const pos = positions[i];
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${pos.chain}/${pos.pairAddress}`, { signal: AbortSignal.timeout(6000) });
        const data = await res.json();
        if (!data.pair) continue;
        const newPrice = parseFloat(data.pair.priceUsd) || pos.currentPrice;

        // Rug pull
        const priceChg = (newPrice - pos.entryPrice) / pos.entryPrice * 100;
        if (priceChg <= -80) {
          pos.currentPrice = newPrice; pos.pnlPct = -100; pos.pnl = -pos.currentSize;
          addLog('💀', `RUG PULL $${pos.symbol} — ${priceChg.toFixed(0)}%`);
          closeTrade(pos, 'RUG'); continue;
        }

        // Liquidity remove
        const curLiq = parseFloat(data.pair.liquidity?.usd) || 0;
        if (pos.entryLiquidity && curLiq < pos.entryLiquidity * 0.3) {
          pos.currentPrice = newPrice; pos.pnlPct = Math.min(priceChg, -50);
          pos.pnl = pos.currentSize * (pos.pnlPct / 100);
          addLog('💀', `LIQ REMOVED $${pos.symbol}`);
          closeTrade(pos, 'LIQ REMOVE'); continue;
        }

        pos.currentPrice = newPrice;
        const change = (newPrice - pos.entryPrice) / pos.entryPrice;
        pos.pnlPct = change * 100;
        pos.pnl = pos.currentSize * change + pos.dcaSecured;
        if (pos.pnlPct > pos.highestPnlPct) pos.highestPnlPct = pos.pnlPct;

        // Momentum data
        const b5 = data.pair.txns?.m5?.buys || 0, s5 = data.pair.txns?.m5?.sells || 0;
        pos.lastBuyRatio = (b5 + s5) > 0 ? (b5 / (b5 + s5)) * 100 : 50;
        const holdTime = (Date.now() - pos.entryTime) / 60000;

        // DCA Out
        if (pos.dcaLevel < 3 && !pos.isMoonBag) {
          if (pos.dcaLevel === 0 && pos.pnlPct >= 15) partialSell(pos, 35, 'DCA 1', 1);
          else if (pos.dcaLevel === 1 && pos.pnlPct >= 40) partialSell(pos, 35, 'DCA 2', 2);
          else if (pos.dcaLevel === 2 && pos.pnlPct >= 80) partialSell(pos, 20, 'DCA 3', 3);
        }

        // Trailing Stop
        const trailAct = pos.isMoonBag ? 10 : 10;
        if (pos.pnlPct >= trailAct && !pos.trailingActivated) {
          pos.trailingActivated = true; pos.trailingHigh = pos.pnlPct;
          addLog('📈', `TRAILING $${pos.symbol} at +${pos.pnlPct.toFixed(0)}%`);
        }
        if (pos.trailingActivated) {
          if (pos.pnlPct > pos.trailingHigh) pos.trailingHigh = pos.pnlPct;
          // Dynamic trail
          let td = 20;
          if (pos.trailingHigh >= 150) td = 20 * 0.6;
          else if (pos.trailingHigh >= 100) td = 20 * 0.8;
          else if (pos.trailingHigh >= 40) td = 10;
          if (pos.isMoonBag) td = Math.max(8, td * 0.7);
          pos.currentTrailDistance = td;
          const drop = pos.trailingHigh - pos.pnlPct;
          if (drop >= td) {
            addLog('📉', `TRAIL HIT $${pos.symbol} — Peak +${pos.trailingHigh.toFixed(0)}% → +${pos.pnlPct.toFixed(1)}%`);
            closeTrade(pos, 'TRAIL'); continue;
          }
        }

        // Timeout
        if (!pos.isMoonBag && holdTime >= pos.maxHold) {
          if (pos.extended < pos.maxExtend) {
            const b5r = pos.lastBuyRatio;
            const prompt = `$${pos.symbol} | Current P&L: ${pos.pnlPct > 0 ? '+' : ''}${pos.pnlPct.toFixed(0)}%\n5m: ${parseFloat(data.pair.priceChange?.m5||0) > 0 ? '+' : ''}${parseFloat(data.pair.priceChange?.m5||0).toFixed(0)}% | Buy ratio: ${b5r.toFixed(0)}%\nHOLD = Keep position\nSELL = Exit now\nReply ONLY: HOLD or SELL`;
            const analysis = (await askAI(prompt)).toUpperCase();
            if (analysis.includes('HOLD') && pos.pnlPct >= -5) {
              pos.entryTime = Date.now(); pos.extended++;
              addLog('🔄', `Extended $${pos.symbol} — ${pos.extended}/${pos.maxExtend}`);
            } else { closeTrade(pos, 'TIMEOUT'); }
          } else { closeTrade(pos, 'MAX TIME'); }
          continue;
        }
      } catch (e) { /* silent */ }
    }
    broadcastState();
  }

  // ═══ MOMENTUM EXIT ═══
  async function checkMomentumExit() {
    if (positions.length === 0) return;
    for (let i = positions.length - 1; i >= 0; i--) {
      const pos = positions[i];
      if (pos.isMoonBag || pos.pnlPct < 5) continue;
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${pos.chain}/${pos.pairAddress}`, { signal: AbortSignal.timeout(5000) });
        const data = await res.json();
        if (!data.pair) continue;
        const b5 = data.pair.txns?.m5?.buys || 0, s5 = data.pair.txns?.m5?.sells || 0;
        if ((b5 + s5) < 5) continue;
        const ratio = (b5 / (b5 + s5)) * 100;
        pos.lastBuyRatio = ratio;
        if (ratio < 35) {
          pos.consecutiveBadMomentum++;
          if (pos.consecutiveBadMomentum >= 2) {
            addLog('📉', `MOMENTUM EXIT $${pos.symbol} — Buyers: ${ratio.toFixed(0)}%`);
            closeTrade(pos, 'MOMENTUM');
          }
        } else { pos.consecutiveBadMomentum = 0; }
      } catch (e) { /* silent */ }
    }
  }

  // ═══ SCAN ═══
  async function scan() {
    if (!isRunning) return;
    const allPairs = new Map();

    // Source 1: Latest profiles
    try {
      const res = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      if (Array.isArray(data)) {
        for (const t of data.slice(0, 120)) {
          if (t.tokenAddress && CHAINS.includes(t.chainId))
            allPairs.set(t.tokenAddress, { address: t.tokenAddress, chain: t.chainId, source: 'new', boost: 12 });
        }
      }
    } catch(e) { console.warn('Scan src1 err:', e.message); }

    // Source 2: Top boosted
    try {
      const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1', { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      if (Array.isArray(data)) {
        for (const t of data.slice(0, 120)) {
          if (t.tokenAddress && CHAINS.includes(t.chainId) && !allPairs.has(t.tokenAddress))
            allPairs.set(t.tokenAddress, { address: t.tokenAddress, chain: t.chainId, source: 'boosted', boost: 18 });
        }
      }
    } catch(e) { console.warn('Scan src2 err:', e.message); }

    // Source 3: Latest boosts
    try {
      const res = await fetch('https://api.dexscreener.com/token-boosts/latest/v1', { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      if (Array.isArray(data)) {
        for (const t of data.slice(0, 100)) {
          if (t.tokenAddress && CHAINS.includes(t.chainId) && !allPairs.has(t.tokenAddress))
            allPairs.set(t.tokenAddress, { address: t.tokenAddress, chain: t.chainId, source: 'boost-new', boost: 15 });
        }
      }
    } catch(e) { console.warn('Scan src3 err:', e.message); }

    // Source 4: Top gainers
    try {
      for (const chain of CHAINS) {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${chain}`, { signal: AbortSignal.timeout(6000) });
        const data = await res.json();
        if (data.pairs) {
          const gainers = data.pairs.filter(p => p.chainId === chain && parseFloat(p.priceChange?.h1) > 0)
            .sort((a, b) => (parseFloat(b.priceChange?.h1) || 0) - (parseFloat(a.priceChange?.h1) || 0)).slice(0, 80);
          for (const p of gainers) {
            const addr = p.baseToken?.address;
            if (addr && !allPairs.has(addr))
              allPairs.set(addr, { address: addr, chain: p.chainId, source: 'gainer', boost: 14, pair: p });
          }
        }
      }
    } catch(e) { console.warn('Scan src4 err:', e.message); }

    // Source 5: Keyword search (30 random)
    const shuffled = [...KEYWORDS].sort(() => Math.random() - 0.5).slice(0, 30);
    for (let i = 0; i < shuffled.length; i++) {
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${shuffled[i]}`, { signal: AbortSignal.timeout(4000) });
        const data = await res.json();
        if (data.pairs) {
          for (const p of data.pairs.slice(0, 70)) {
            const addr = p.baseToken?.address;
            if (addr && CHAINS.includes(p.chainId) && !allPairs.has(addr))
              allPairs.set(addr, { address: addr, chain: p.chainId, source: 'search', boost: 0, pair: p });
          }
        }
      } catch(e) { /* silent */ }
      if (i % 10 === 9) await new Promise(r => setTimeout(r, 100));
    }

    addLog('🔍', `Scanning ${allPairs.size} tokens...`);

    // Enrich & Filter
    const enriched = [];
    const candidates = Array.from(allPairs.values());
    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      try {
        let pair = cand.pair;
        if (!pair) {
          const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${cand.address}`, { signal: AbortSignal.timeout(3000) });
          const data = await res.json();
          if (data.pairs && data.pairs[0]) pair = data.pairs[0];
        }
        if (pair) {
          const mc = parseFloat(pair.marketCap) || 0;
          const liq = parseFloat(pair.liquidity?.usd) || 0;
          const liqRatio = mc > 0 ? (liq / mc) * 100 : 0;
          if (mc >= 50000 && mc <= 5000000 && liq >= 20000 && liqRatio >= 8) {
            pair._source = cand.source; pair._boost = cand.boost;
            enriched.push(pair);
          }
        }
      } catch(e) { /* silent */ }
      if (i % 25 === 24) await new Promise(r => setTimeout(r, 30));
    }

    scannedTotal = enriched.length;
    lastScanTime = getTime();

    // Score & Filter
    const opportunities = [];
    for (const pair of enriched) {
      const score = calculateScore(pair);
      if (score >= MIN_SCORE) opportunities.push({ pair, score });
    }
    opportunities.sort((a, b) => b.score - a.score);
    oppsTotal = opportunities.length;
    addLog('🔍', `Found ${oppsTotal} opportunities from ${scannedTotal} tokens`);

    // Trade selection
    const topOpps = opportunities.slice(0, 40);
    let tradesOpened = 0;
    const tradingNow = new Set();
    const existAddr = new Set(positions.map(p => p.address));
    const existSym = new Set(positions.map(p => p.symbol));
    const histAddr = new Set(history.slice(0, 50).map(h => h.address));

    for (const opp of topOpps) {
      if (balance < POSITION_SIZE) break;
      const addr = opp.pair.baseToken?.address;
      const symbol = opp.pair.baseToken?.symbol || 'UNKNOWN';
      if (!addr || existAddr.has(addr) || existSym.has(symbol) || tradingNow.has(addr) || histAddr.has(addr)) continue;

      // Check cache
      const cached = getCached(addr);
      if (cached) {
        if (cached.includes('QUICK') || cached.includes('LONG')) {
          const tt = cached.includes('LONG') ? 'LONG' : 'QUICK';
          tradingNow.add(addr); existSym.add(symbol); existAddr.add(addr);
          executeTrade(opp.pair, opp.score, tt); tradesOpened++; continue;
        } else if (cached.includes('SKIP')) continue;
      }

      // Pre-checks
      const chg5m = parseFloat(opp.pair.priceChange?.m5) || 0;
      const chg1h = parseFloat(opp.pair.priceChange?.h1) || 0;
      if (chg5m > 100 || chg1h > 200 || chg5m < -40 || chg1h < -50) { setCache(addr, 'SKIP'); continue; }
      const b5 = opp.pair.txns?.m5?.buys || 0, s5 = opp.pair.txns?.m5?.sells || 0;
      const t5 = b5 + s5;
      if (t5 >= 3) { const r = (b5 / t5) * 100; if (r < 20) { setCache(addr, 'SKIP'); continue; } }

      // AI Analysis
      try {
        const mc = parseFloat(opp.pair.marketCap) || 0;
        const liq = parseFloat(opp.pair.liquidity?.usd) || 0;
        const vol = parseFloat(opp.pair.volume?.h24) || 0;
        const chg6h = parseFloat(opp.pair.priceChange?.h6) || 0;
        const chg24h = parseFloat(opp.pair.priceChange?.h24) || 0;
        const bRatio = t5 > 0 ? ((b5 / t5) * 100).toFixed(0) : '50';
        const prompt = `Memecoin sniper. Quick decision:\n$${symbol}\nMC: $${fN(mc)} | Liq: $${fN(liq)} | Vol24h: $${fN(vol)}\n5m: ${chg5m>0?'+':''}${chg5m.toFixed(0)}%\n1h: ${chg1h>0?'+':''}${chg1h.toFixed(0)}%\n6h: ${chg6h>0?'+':''}${chg6h.toFixed(0)}%\n24h: ${chg24h>0?'+':''}${chg24h.toFixed(0)}%\nBuy ratio 5m: ${bRatio}%\nQUICK = Active pump, scalp 15-30% fast\nLONG = Low MC gem, hold for 50%+\nSKIP = Bad setup\nReply ONLY: QUICK, LONG, or SKIP`;
        const analysis = (await askAI(prompt)).toUpperCase();
        setCache(addr, analysis);
        if (analysis.includes('QUICK') || analysis.includes('LONG')) {
          const tt = analysis.includes('LONG') ? 'LONG' : 'QUICK';
          tradingNow.add(addr); existSym.add(symbol); existAddr.add(addr);
          executeTrade(opp.pair, opp.score, tt); tradesOpened++;
        } else if (!analysis.includes('SKIP') && opp.score >= 60) {
          tradingNow.add(addr); existSym.add(symbol); existAddr.add(addr);
          executeTrade(opp.pair, opp.score, 'QUICK'); tradesOpened++;
        }
      } catch (e) {
        if (opp.score >= 55) {
          const mc = parseFloat(opp.pair.marketCap) || 0;
          tradingNow.add(addr); existSym.add(symbol); existAddr.add(addr);
          executeTrade(opp.pair, opp.score, mc < 100000 ? 'LONG' : 'QUICK'); tradesOpened++;
        }
      }
      await new Promise(r => setTimeout(r, 150));
    }

    broadcastFn('SCAN', 'RESULT', { scanned: scannedTotal, opportunities: oppsTotal, tradesOpened });
    addLog('✅', `Scan complete — ${tradesOpened} trades opened`);
  }

  // ═══ BROADCAST STATE ═══
  function broadcastState() {
    broadcastFn('UPDATE', 'POSITIONS', {
      positions, balance, totalPnL, securedPnL,
      wins, totalTrades, bestTrade, worstTrade,
      scannedTotal, oppsTotal, lastScanTime,
      history: history.slice(0, 50),
      logs: logs.slice(0, 50)
    });
  }

  function getState() {
    return {
      positions, balance, totalPnL, securedPnL,
      wins, totalTrades, bestTrade, worstTrade,
      scannedTotal, oppsTotal, lastScanTime, isRunning,
      history: history.slice(0, 50),
      logs: logs.slice(0, 50)
    };
  }

  // ═══ ENGINE CONTROL ═══
  function start() {
    if (isRunning) return;
    loadState();
    isRunning = true;
    addLog('🚀', 'Sniper engine started — scanning...');

    // Initial scan after 5 seconds
    setTimeout(() => scan(), 5000);
    scanInterval = setInterval(() => scan(), 40000);
    updateInterval = setInterval(() => updatePositions(), 5000);
    momentumInterval = setInterval(() => checkMomentumExit(), 60000);

    console.log('[SNIPER] Engine started');
    broadcastState();
  }

  function stop() {
    isRunning = false;
    if (scanInterval) clearInterval(scanInterval);
    if (updateInterval) clearInterval(updateInterval);
    if (momentumInterval) clearInterval(momentumInterval);
    saveState();
    addLog('⏹️', 'Sniper engine stopped');
    console.log('[SNIPER] Engine stopped');
  }

  return { getState, start, stop };
}

module.exports = { createSniperEngine };
