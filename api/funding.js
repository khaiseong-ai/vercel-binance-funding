const FUNDING_WINDOW_MS = 72 * 60 * 60 * 1000;
const FUNDING_PAGE_LIMIT = 100;
const BACKPACK_FUNDING_PAGE_LIMIT = 1000;
const FUNDING_MAX_PAGES = 3;
const NEGATIVE_FUNDING_SIGN = new Set(['phemex', 'bybit']);
const COINS = ['USDT', 'USDC'];
const HOUR_MS = 60 * 60 * 1000;
const COMMON_FUNDING_INTERVALS = [1, 2, 4, 8, 12, 24];
const HYPERLIQUID_REST_BASE = process.env.HYPERLIQUID_REST_BASE || 'https://api.hyperliquid.xyz';
const FUNDING_RELAY_EXCHANGES = new Set(['binance', 'bybit']);
const RESPONSE_CACHE_TTL_MS = Math.max(
  30 * 1000,
  Number(process.env.FUNDING_CACHE_TTL_MS) || 60 * 1000
);

const toSGTime = (ts) =>
  new Date(ts).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' });

let ccxtModulePromise;
const loadCcxt = async () => {
  if (!ccxtModulePromise) ccxtModulePromise = import('ccxt');
  const mod = await ccxtModulePromise;
  return mod.default || mod;
};

let ed25519ModulePromise;
const loadEd25519 = async () => {
  if (!ed25519ModulePromise) {
    ed25519ModulePromise = import('@noble/curves/ed25519.js');
  }
  const mod = await ed25519ModulePromise;
  return mod.ed25519;
};

const backpackMarketId = (symbol) => {
  if (!symbol) return symbol;
  if (symbol.includes('_')) return symbol;
  const [base, rest] = symbol.split('/');
  const quote = (rest || '').split(':')[0] || 'USDC';
  return `${base}_${quote}_PERP`;
};

const backpackUnifiedSymbol = (exchange, marketId) => {
  const raw = exchange.markets_by_id?.[marketId];
  const market = Array.isArray(raw) ? raw[0] : raw;
  if (market?.symbol) return market.symbol;
  const match = String(marketId || '').match(/^(.+)_([^_]+)_PERP$/);
  return match ? `${match[1]}/${match[2]}:${match[2]}` : marketId;
};

async function backpackSignedRequest(path, instruction, params = {}) {
  const apiKey = process.env.BACKPACK_API_KEY;
  const secret = process.env.BACKPACK_API_SECRET;
  if (!apiKey || !secret) throw new Error('Missing BACKPACK_API_KEY or BACKPACK_API_SECRET');

  const timestamp = Date.now().toString();
  const windowMs = '60000';
  const sortedParams = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  const query = sortedParams
    .map(([key, value]) => {
      const normalized = typeof value === 'boolean' ? String(value).toLowerCase() : String(value);
      return `${encodeURIComponent(key)}=${encodeURIComponent(normalized)}`;
    })
    .join('&');
  const payload = `instruction=${instruction}${query ? `&${query}` : ''}&timestamp=${timestamp}&window=${windowMs}`;
  const ed25519 = await loadEd25519();
  const signature = Buffer
    .from(ed25519.sign(Buffer.from(payload), Buffer.from(secret, 'base64')))
    .toString('base64');
  const url = `https://api.backpack.exchange/${path}${query ? `?${query}` : ''}`;
  const response = await fetch(url, {
    headers: {
      'X-API-Key': apiKey,
      'X-Signature': signature,
      'X-Timestamp': timestamp,
      'X-Window': windowMs,
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = typeof data === 'object' ? JSON.stringify(data) : text;
    throw new Error(`backpack ${message}`);
  }
  return data;
}

const cleanSymbol = (s) => {
  if (!s) return s;
  let out = String(s).toUpperCase();
  if (out.includes('/')) out = out.split('/')[0];
  else if (out.includes(':')) out = out.split(':').pop();
  const aliases = { BROCCOLI714: 'BROCCOLI', CL: 'XTI', MONAD: 'MON', PUMPFUN: 'PUMP' };
  return aliases[out] || out;
};

async function hyperliquidInfo(body) {
  const response = await fetch(`${HYPERLIQUID_REST_BASE}/info`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`hyperliquid ${body.type} HTTP ${response.status}: ${text.slice(0, 200)}`);
  return data;
}

function requestedFundingRelayExchanges() {
  return String(process.env.POSITION_RELAY_EXCHANGES || 'bybit')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => FUNDING_RELAY_EXCHANGES.has(name));
}

async function fetchFundingRelay(nowMs, sinceMs, fetchImpl = fetch) {
  const rawUrl = String(process.env.POSITION_RELAY_URL || '').trim();
  const token = await relayAuthorizationToken(fetchImpl);
  if (!rawUrl && !token) return { exchanges: {}, failures: {} };
  if (!rawUrl || !token) throw new Error('Funding relay configuration is incomplete');

  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error('Funding relay URL must use HTTPS');
  url.pathname = '/funding';
  url.search = '';
  url.hash = '';
  const requestedExchanges = requestedFundingRelayExchanges();
  const credentials = {};
  if (requestedExchanges.includes('binance')) {
    credentials.binance = {
      apiKey: process.env.BINANCE_API_KEY || '',
      apiSecret: process.env.BINANCE_API_SECRET || '',
    };
  }
  if (requestedExchanges.includes('bybit')) {
    credentials.bybit = {
      apiKey: process.env.BYBIT_API_KEY || '',
      apiSecret: process.env.BYBIT_API_SECRET || '',
    };
  }
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      startTime: sinceMs,
      endTime: nowMs,
      exchanges: requestedExchanges,
      credentials,
    }),
    redirect: 'follow',
    signal: AbortSignal.timeout(120000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok || !body.exchanges || typeof body.exchanges !== 'object') {
    throw new Error(`Funding relay unavailable with HTTP ${response.status}`);
  }

  const exchanges = {};
  for (const name of FUNDING_RELAY_EXCHANGES) {
    const value = body.exchanges[name];
    if (!value || !Array.isArray(value.positions) || !Array.isArray(value.orders)) continue;
    exchanges[name] = {
      equity: sanitizeRelayEquity(value.equity),
      positions: value.positions.map((row) => sanitizeRelayPosition(name, row)).filter(Boolean),
      orders: value.orders.map((row) => sanitizeRelayOrder(name, row)).filter(Boolean),
    };
  }
  return {
    exchanges,
    failures: body.failures && typeof body.failures === 'object' ? body.failures : {},
  };
}

async function relayAuthorizationToken(fetchImpl) {
  const requestUrl = String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL || '').trim();
  const requestToken = String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || '').trim();
  if (requestUrl && requestToken) {
    const url = new URL(requestUrl);
    url.searchParams.set('audience', 'position-relay');
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${requestToken}` },
      signal: AbortSignal.timeout(30000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !String(body?.value || '').trim()) {
      throw new Error('Funding relay OIDC authorization failed');
    }
    return String(body.value).trim();
  }
  return String(process.env.POSITION_RELAY_TOKEN || '').trim();
}

function sanitizeRelayEquity(value) {
  const equity = emptyWallet();
  for (const bucket of ['futures', 'spot', 'funding']) {
    equity[bucket].USDT = num(value?.[bucket]?.USDT);
    equity[bucket].USDC = num(value?.[bucket]?.USDC);
  }
  equity.unrealizedPnl = num(value?.unrealizedPnl);
  equity.total = sumWallet(equity);
  return equity;
}

function sanitizeRelayPosition(name, row) {
  const positionSize = Math.abs(num(row?.positionSize));
  const side = String(row?.side || '').toLowerCase();
  const symbol = cleanSymbol(row?.symbol);
  if (!positionSize || !symbol || !['long', 'short'].includes(side)) return null;
  const fundingRecords = Array.isArray(row.fundingRecords) ? row.fundingRecords.map(num) : [];
  return {
    source: name,
    symbol,
    rawSymbol: String(row.rawSymbol || row.symbol || ''),
    side,
    currentPrice: num(row.currentPrice),
    entryPrice: num(row.entryPrice),
    positionSize,
    positionValue: Math.abs(num(row.positionValue)),
    unrealizedPnl: num(row.unrealizedPnl),
    count: fundingRecords.length,
    fundingIntervalHours: num(row.fundingIntervalHours),
    totalFunding: fundingRecords.reduce((sum, amount) => sum + amount, 0),
    fundingRecords,
    startTime: String(row.startTime || ''),
    endTime: String(row.endTime || ''),
  };
}

function sanitizeRelayOrder(name, row) {
  const price = num(row?.price);
  const triggerPrice = num(row?.triggerPrice);
  const amount = Math.abs(num(row?.amount));
  const symbol = cleanSymbol(row?.symbol);
  if (!symbol || (!price && !triggerPrice)) return null;
  return {
    exchange: name,
    symbol,
    side: String(row.side || '').toLowerCase(),
    price: price || triggerPrice,
    triggerPrice,
    limitPrice: num(row.limitPrice),
    amount,
    kind: String(row.kind || 'LIMIT').toUpperCase(),
    orderType: String(row.orderType || '').toUpperCase(),
  };
}

async function fetchHyperliquidAccount(nowMs, sinceMs) {
  const wallet = process.env.HYPERLIQUID_WALLET;
  if (!wallet) return { equity: emptyWallet(), positions: [], orders: [] };
  const configured = String(process.env.HYPERLIQUID_DEXS || 'xyz')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const dexes = ['', ...configured].filter((value, index, values) => values.indexOf(value) === index);

  const perDex = await Promise.all(dexes.map(async (dex) => {
    const dexParam = dex ? { dex } : {};
    const [state, funding, openOrders] = await Promise.all([
      hyperliquidInfo({ type: 'clearinghouseState', user: wallet, ...dexParam }),
      hyperliquidInfo({ type: 'userFunding', user: wallet, startTime: sinceMs, endTime: nowMs, ...dexParam }),
      hyperliquidInfo({ type: 'frontendOpenOrders', user: wallet, ...dexParam }),
    ]);
    return { state, funding, openOrders };
  }));

  const equity = emptyWallet();
  equity.futures.USDC = perDex.reduce(
    (sum, item) => sum + num(item.state?.marginSummary?.accountValue), 0
  );
  equity.total = sumWallet(equity);

  const positions = [];
  const orders = [];
  for (const { state, funding, openOrders } of perDex) {
    const fundingByCoin = new Map();
    for (const record of funding || []) {
      const coin = record?.delta?.coin;
      if (!coin) continue;
      if (!fundingByCoin.has(coin)) fundingByCoin.set(coin, []);
      fundingByCoin.get(coin).push({
        timestamp: num(record.time),
        amount: num(record.delta?.usdc),
      });
    }

    const sizeByCoin = new Map();
    for (const item of state?.assetPositions || []) {
      const pos = item.position || item;
      const signedSize = num(pos.szi);
      if (!signedSize) continue;
      const positionSize = Math.abs(signedSize);
      const records = (fundingByCoin.get(pos.coin) || []).sort((a, b) => b.timestamp - a.timestamp);
      const positionValue = Math.abs(num(pos.positionValue));
      const currentPrice = positionSize ? positionValue / positionSize : 0;
      sizeByCoin.set(pos.coin, positionSize);
      positions.push({
        source: 'hyperliquid',
        symbol: cleanSymbol(pos.coin),
        rawSymbol: pos.coin,
        side: signedSize > 0 ? 'long' : 'short',
        currentPrice,
        entryPrice: num(pos.entryPx),
        positionSize,
        positionValue,
        unrealizedPnl: num(pos.unrealizedPnl),
        count: records.length,
        fundingIntervalHours: 1,
        totalFunding: records.reduce((sum, record) => sum + record.amount, 0),
        fundingRecords: records.map((record) => record.amount),
        startTime: toSGTime(sinceMs),
        endTime: toSGTime(nowMs),
      });
    }

    for (const order of openOrders || []) {
      const triggerPrice = num(order.triggerPx);
      const limitPrice = num(order.limitPx);
      const orderType = String(order.orderType || (order.isTrigger ? 'TRIGGER' : 'LIMIT')).toUpperCase();
      let kind = 'LIMIT';
      if (/TAKE PROFIT|TAKE_PROFIT|TAKEPROFIT/.test(orderType)) kind = 'TP';
      else if (/STOP/.test(orderType)) kind = 'SL';
      else if (triggerPrice) kind = 'TRIGGER';
      orders.push({
        exchange: 'hyperliquid',
        symbol: cleanSymbol(order.coin),
        side: order.side === 'B' ? 'buy' : 'sell',
        price: triggerPrice || limitPrice,
        triggerPrice,
        limitPrice,
        amount: num(order.sz || order.origSz) || sizeByCoin.get(order.coin) || 0,
        kind,
        orderType,
      });
    }
  }
  return { equity, positions, orders };
}

const convertMexcOrderSide = (code) => {
  if (code === '1' || code === 1 || code === '3' || code === 3) return 'buy';
  if (code === '2' || code === 2 || code === '4' || code === 4) return 'sell';
  return code;
};

const num = (v) => parseFloat(v || 0) || 0;

const emptyWallet = () => ({
  futures: { USDT: 0, USDC: 0 },
  spot: { USDT: 0, USDC: 0 },
  funding: { USDT: 0, USDC: 0 },
  total: 0,
});

const sumWallet = (w) => {
  let t = 0;
  for (const bucket of ['futures', 'spot', 'funding']) {
    for (const coin of COINS) t += w[bucket][coin] || 0;
  }
  return t;
};

async function buildExchanges() {
  const ccxt = await loadCcxt();
  return {
    binance: new ccxt.binance({
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_API_SECRET,
      enableRateLimit: true,
      options: { defaultType: 'future', warnOnFetchOpenOrdersWithoutSymbol: false },
    }),
    phemex: new ccxt.phemex({
      apiKey: process.env.PHEMEX_API_KEY,
      secret: process.env.PHEMEX_API_SECRET,
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    }),
    bybit: new ccxt.bybit({
      apiKey: process.env.BYBIT_API_KEY,
      secret: process.env.BYBIT_API_SECRET,
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    }),
    mexc: new ccxt.mexc({
      apiKey: process.env.MEXC_API_KEY,
      secret: process.env.MEXC_API_SECRET,
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    }),
    bitget: new ccxt.bitget({
      apiKey: process.env.BITGET_API_KEY,
      secret: process.env.BITGET_API_SECRET,
      password: process.env.BITGET_API_PASSWORD || process.env.BITGET_API_PASSPHRASE,
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    }),
    backpack: new ccxt.backpack({
      apiKey: process.env.BACKPACK_API_KEY,
      secret: process.env.BACKPACK_API_SECRET,
      enableRateLimit: true,
      options: { defaultType: 'swap', recvWindow: 60000 },
    }),
  };
}

let exchangesPromise;
const getExchanges = async () => {
  if (!exchangesPromise) {
    exchangesPromise = buildExchanges().catch((err) => {
      exchangesPromise = null;
      throw err;
    });
  }
  return exchangesPromise;
};

// ---------- 余额 ----------
async function fetchBinanceEquity(ex) {
  const w = emptyWallet();
  const [umBal, spotBal, fundingBal] = await Promise.all([
    ex.fetchBalance({ type: 'future' }).catch(() => ({})),
    ex.fetchBalance({ type: 'spot' }).catch(() => ({})),
    ex.fetchBalance({ type: 'funding' }).catch(() => ({})),
  ]);

  const umAssets = umBal?.info?.assets || [];
  for (const a of umAssets) {
    if (a.asset === 'USDT') w.futures.USDT = num(a.marginBalance);
    if (a.asset === 'USDC') w.futures.USDC = num(a.marginBalance);
  }
  if (!w.futures.USDT && !w.futures.USDC) {
    w.futures.USDT = num(umBal?.info?.totalMarginBalance);
  }

  w.spot.USDT = num(spotBal?.total?.USDT);
  w.spot.USDC = num(spotBal?.total?.USDC);
  w.funding.USDT = num(fundingBal?.total?.USDT || fundingBal?.free?.USDT);
  w.funding.USDC = num(fundingBal?.total?.USDC || fundingBal?.free?.USDC);

  w.total = sumWallet(w);
  return w;
}

async function fetchPhemexEquity(ex) {
  const w = emptyWallet();
  const [usdtSwap, usdcSwap, spot] = await Promise.all([
    ex.fetchBalance({ type: 'swap', code: 'USDT' }).catch(() => ({})),
    ex.fetchBalance({ type: 'swap', code: 'USDC' }).catch(() => ({})),
    ex.fetchBalance({ type: 'spot' }).catch(() => ({})),
  ]);

  const parsePhemex = (bal, fallbackCoin) => {
    let v = num(bal?.info?.data?.account?.accountBalanceRv);
    if (!v) {
      const ev = bal?.info?.data?.account?.accountBalanceEv;
      if (ev) v = num(ev) / 1e8;
    }
    if (!v) v = num(bal?.total?.[fallbackCoin]);
    return v;
  };

  w.futures.USDT = parsePhemex(usdtSwap, 'USDT');
  w.futures.USDC = parsePhemex(usdcSwap, 'USDC');
  w.spot.USDT = num(spot?.total?.USDT);
  w.spot.USDC = num(spot?.total?.USDC);

  w.total = sumWallet(w);
  return w;
}

async function fetchBybitEquity(ex) {
  const w = emptyWallet();
  const [unified, fund] = await Promise.all([
    ex.fetchBalance({ type: 'unified' }).catch(() =>
      ex.fetchBalance({ type: 'swap' }).catch(() => ({}))
    ),
    ex.fetchBalance({ type: 'funding' }).catch(() => ({})),
  ]);

  const coinList = unified?.info?.result?.list?.[0]?.coin || [];
  for (const c of coinList) {
    if (c.coin === 'USDT') w.futures.USDT = num(c.equity || c.walletBalance);
    if (c.coin === 'USDC') w.futures.USDC = num(c.equity || c.walletBalance);
  }
  if (!w.futures.USDT && !w.futures.USDC) {
    w.futures.USDT = num(unified?.info?.result?.list?.[0]?.totalEquity);
  }

  const fundList = fund?.info?.result?.balance || [];
  for (const b of fundList) {
    if (b.coin === 'USDT') w.funding.USDT = num(b.walletBalance);
    if (b.coin === 'USDC') w.funding.USDC = num(b.walletBalance);
  }

  w.total = sumWallet(w);
  return w;
}

async function fetchMexcEquity(ex) {
  const w = emptyWallet();
  const [swapBal, spotBal] = await Promise.all([
    ex.fetchBalance({ type: 'swap' }).catch(() => ({})),
    ex.fetchBalance({ type: 'spot' }).catch(() => ({})),
  ]);

  const dataArr = swapBal?.info?.data;
  if (Array.isArray(dataArr)) {
    for (const c of dataArr) {
      if (c.currency === 'USDT') w.futures.USDT = num(c.equity);
      if (c.currency === 'USDC') w.futures.USDC = num(c.equity);
    }
  } else if (dataArr && typeof dataArr === 'object') {
    w.futures.USDT = num(dataArr.equity || dataArr.availableBalance);
  }
  if (!w.futures.USDT && !w.futures.USDC) {
    w.futures.USDT = num(swapBal?.total?.USDT);
    w.futures.USDC = num(swapBal?.total?.USDC);
  }

  w.spot.USDT = num(spotBal?.total?.USDT);
  w.spot.USDC = num(spotBal?.total?.USDC);

  w.total = sumWallet(w);
  return w;
}

async function fetchBitgetEquity(ex) {
  const w = emptyWallet();
  const [swapBal, spotBal] = await Promise.all([
    ex.fetchBalance({ type: 'swap' }).catch(() => ({})),
    ex.fetchBalance({ type: 'spot' }).catch(() => ({})),
  ]);

  const parseBalanceCoin = (bal, coin) =>
    num(
      bal?.total?.[coin] ||
      bal?.free?.[coin] ||
      bal?.used?.[coin] ||
      bal?.[coin]?.total ||
      bal?.[coin]?.free
    );

  w.futures.USDT = parseBalanceCoin(swapBal, 'USDT');
  w.futures.USDC = parseBalanceCoin(swapBal, 'USDC');

  const swapInfo = swapBal?.info?.data;
  const swapRows = Array.isArray(swapInfo) ? swapInfo : (swapInfo ? [swapInfo] : []);
  for (const row of swapRows) {
    const coin = row.marginCoin || row.coin || row.currency;
    if (coin === 'USDT') {
      w.futures.USDT = num(row.usdtEquity || row.equity || row.accountEquity || row.marginBalance || row.available);
    }
    if (coin === 'USDC') {
      w.futures.USDC = num(row.usdcEquity || row.equity || row.accountEquity || row.marginBalance || row.available);
    }
  }

  w.spot.USDT = parseBalanceCoin(spotBal, 'USDT');
  w.spot.USDC = parseBalanceCoin(spotBal, 'USDC');

  w.total = sumWallet(w);
  return w;
}

async function fetchBackpackEquity(ex) {
  const w = emptyWallet();
  const [balance, collateral] = await Promise.all([
    backpackSignedRequest('api/v1/capital', 'balanceQuery').catch(() => ({})),
    backpackSignedRequest('api/v1/capital/collateral', 'collateralQuery').catch(() => ({})),
  ]);

  const netEquity = num(collateral?.netEquity);
  if (netEquity) {
    w.futures.USDC = netEquity;
    w.total = sumWallet(w);
    return w;
  }

  const parseBalanceCoin = (coin) =>
    num(balance?.[coin]?.available) +
    num(balance?.[coin]?.locked) +
    num(balance?.[coin]?.staked) +
    num(balance?.[coin]?.total) +
    num(balance?.[coin]?.free) +
    num(balance?.total?.[coin]) +
    num(balance?.free?.[coin]);

  // Backpack uses one portfolio-style capital account and perps settle in USDC,
  // so keep USDC/USDT under futures to avoid double counting the same wallet.
  w.futures.USDC = parseBalanceCoin('USDC');
  w.futures.USDT = parseBalanceCoin('USDT');

  w.total = sumWallet(w);
  return w;
}

const BALANCE_FETCHERS = {
  binance: fetchBinanceEquity,
  phemex: fetchPhemexEquity,
  bybit: fetchBybitEquity,
  mexc: fetchMexcEquity,
  bitget: fetchBitgetEquity,
  backpack: fetchBackpackEquity,
};

// ---------- Ticker ----------
async function buildTickerCache(exchange, symbols) {
  if (!symbols.length) return {};
  try {
    const tickers = await exchange.fetchTickers(symbols);
    return tickers || {};
  } catch {
    const entries = await Promise.all(
      symbols.map(async (s) => {
        try { return [s, await exchange.fetchTicker(s)]; }
        catch { return [s, null]; }
      })
    );
    return Object.fromEntries(entries.filter(([, t]) => t));
  }
}

function computePnL(pos, ticker, positionSize) {
  const currentPrice = ticker?.last || pos.markPrice || num(pos.info?.markPrice) || 0;
  const avgPrice = pos.entryPrice || pos.entry_price || 0;
  const amount = Math.abs(positionSize || pos.contracts || pos.positionAmt || 0);
  const side = pos.side || (pos.contracts > 0 ? 'long' : 'short');

  let pnl = (currentPrice - avgPrice) * amount;
  if (String(side).toLowerCase().includes('short')) {
    pnl = (avgPrice - currentPrice) * amount;
  }
  return { unrealizedPnl: pnl, positionValue: currentPrice * amount, currentPrice, side };
}

// ---------- Funding ----------
const parseIntervalHours = (value) => {
  if (value == null) return 0;
  if (typeof value === 'number') {
    if (value > HOUR_MS) return value / HOUR_MS;
    if (value > 24 && value <= 1440) return value / 60;
    if (value > 1440) return value / 3600;
    return value;
  }

  const text = String(value).trim().toLowerCase();
  const match = text.match(/([\d.]+)\s*(h|hr|hour|m|min|minute)/);
  if (!match) return parseIntervalHours(num(text));
  const amount = num(match[1]);
  return match[2].startsWith('m') ? amount / 60 : amount;
};

const closestCommonInterval = (hours) => {
  if (!hours) return 0;
  let closest = COMMON_FUNDING_INTERVALS[0];
  for (const candidate of COMMON_FUNDING_INTERVALS) {
    if (Math.abs(candidate - hours) < Math.abs(closest - hours)) closest = candidate;
  }
  return Math.abs(closest - hours) <= Math.max(0.2, closest * 0.15) ? closest : hours;
};

function inferFundingInterval(records) {
  const timestamps = [...new Set(
    records.map((r) => num(r.timestamp)).filter(Boolean)
  )].sort((a, b) => a - b);
  if (timestamps.length < 2) return 0;

  const counts = new Map();
  for (let i = 1; i < timestamps.length; i++) {
    const hours = closestCommonInterval((timestamps[i] - timestamps[i - 1]) / HOUR_MS);
    if (hours > 0 && hours <= 24) counts.set(hours, (counts.get(hours) || 0) + 1);
  }
  if (!counts.size) return 0;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

function fundingIntervalFromRate(rate, market) {
  const info = rate?.info || {};
  const marketInfo = market?.info || {};
  const candidates = [
    rate?.interval,
    rate?.fundingInterval,
    rate?.fundingIntervalHours,
    info.fundingInterval,
    info.fundingIntervalHours,
    info.fundingRateInterval,
    info.ratePeriod,
    marketInfo.fundingInterval,
    marketInfo.fundingIntervalHours,
    marketInfo.fundingRateInterval,
  ];
  for (const value of candidates) {
    const hours = closestCommonInterval(parseIntervalHours(value));
    if (hours > 0 && hours <= 24) return hours;
  }
  return 0;
}

async function buildFundingRateCache(exchange, symbols) {
  if (!symbols.length || !exchange.has?.fetchFundingRates) return {};
  try {
    return await exchange.fetchFundingRates(symbols) || {};
  } catch {
    console.error('Funding rate cache unavailable');
    return {};
  }
}

async function buildFundingIntervalCache(exchange, symbols) {
  if (!symbols.length) return {};
  if (exchange.has?.fetchFundingIntervals) {
    try {
      return await exchange.fetchFundingIntervals(symbols) || {};
    } catch {
      console.error('Funding interval cache unavailable');
    }
  }
  if (exchange.has?.fetchFundingInterval) {
    const entries = await Promise.all(symbols.map(async (symbol) => {
      try {
        return [symbol, await exchange.fetchFundingInterval(symbol)];
      } catch {
        return [symbol, null];
      }
    }));
    return Object.fromEntries(entries.filter(([, interval]) => interval));
  }
  return {};
}

async function fetchFundingInterval(exchange, symbol) {
  if (!exchange.has?.fetchFundingInterval) return null;
  try {
    return await exchange.fetchFundingInterval(symbol);
  } catch {
    return null;
  }
}

async function fetchFundingWindow(exchange, symbol, sinceMs, nowMs) {
  if (exchange.id === 'backpack') {
    const seen = new Set();
    const all = [];
    const marketId = backpackMarketId(symbol);

    for (let i = 0; i < FUNDING_MAX_PAGES; i++) {
      let page;
      try {
        page = await backpackSignedRequest(
          'wapi/v1/history/funding',
          'fundingHistoryQueryAll',
          {
            symbol: marketId,
            limit: BACKPACK_FUNDING_PAGE_LIMIT,
            offset: i * BACKPACK_FUNDING_PAGE_LIMIT,
          }
        );
      } catch {
        console.error('Backpack funding history unavailable');
        break;
      }
      if (!page?.length) break;

      for (const f of page) {
        const timestamp = Date.parse(`${f.intervalEndTimestamp}Z`);
        if (timestamp >= sinceMs && timestamp <= nowMs) {
          const key = `${f.symbol}-${timestamp}-${f.quantity}-${f.fundingRate}`;
          if (!seen.has(key)) {
            seen.add(key);
            all.push({
              symbol: backpackUnifiedSymbol(exchange, f.symbol),
              timestamp,
              amount: num(f.quantity),
              rate: num(f.fundingRate),
              info: f,
            });
          }
        }
      }

      const oldest = Math.min(...page.map((f) => Date.parse(`${f.intervalEndTimestamp}Z`)).filter(Boolean));
      if (!oldest || oldest < sinceMs || page.length < BACKPACK_FUNDING_PAGE_LIMIT) break;
    }

    return all.sort((a, b) => b.timestamp - a.timestamp);
  }

  if (exchange.id === 'bitget') {
    try {
      const chunkMs = 24 * HOUR_MS;
      const chunks = [];
      for (let start = sinceMs; start < nowMs; start += chunkMs) {
        const end = Math.min(start + chunkMs - 1, nowMs);
        chunks.push(
          exchange.fetchFundingHistory(
            symbol,
            start,
            FUNDING_PAGE_LIMIT,
            { until: end }
          ).catch(() => [])
        );
      }

      const pages = await Promise.all(chunks);
      const seen = new Set();
      return pages.flat()
        .filter((record) => record.timestamp >= sinceMs && record.timestamp <= nowMs)
        .filter((record) => {
          const key = record.id || `${record.timestamp}-${record.amount}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => b.timestamp - a.timestamp);
    } catch {
      console.error('Bitget funding chunks unavailable');
    }
  }

  const seen = new Set();
  const all = [];
  let start = sinceMs;

  for (let i = 0; i < FUNDING_MAX_PAGES; i++) {
    let page;
    try { page = await exchange.fetchFundingHistory(symbol, start, FUNDING_PAGE_LIMIT); }
    catch { break; }
    if (!page?.length) break;

    for (const f of page) {
      if (f.timestamp >= sinceMs && f.timestamp <= nowMs) {
        const key = `${f.timestamp}-${f.amount}`;
        if (!seen.has(key)) { seen.add(key); all.push(f); }
      }
    }
    const last = page[page.length - 1]?.timestamp;
    if (!last || last <= start || page.length < FUNDING_PAGE_LIMIT) break;
    start = last + 1;
  }
  all.sort((a, b) => b.timestamp - a.timestamp);
  return all;
}

// ---------- 持仓 ----------
async function fetchBackpackPositions(exchange) {
  const positions = await backpackSignedRequest('api/v1/position', 'positionQuery');
  return (positions || []).map((p) => {
    const netQuantity = num(p.netQuantity ?? p.netExposureQuantity);
    const contracts = Math.abs(netQuantity);
    return {
      info: p,
      id: p.positionId,
      symbol: backpackUnifiedSymbol(exchange, p.symbol),
      side: netQuantity < 0 ? 'short' : 'long',
      contracts,
      entryPrice: num(p.entryPrice || p.breakEvenPrice),
      markPrice: num(p.markPrice),
      unrealizedPnl: num(p.pnlUnrealized),
    };
  });
}

async function fetchFundingSchedule(exchange, symbol, sinceMs, nowMs) {
  if (!exchange.has?.fetchFundingRateHistory) return [];

  const seen = new Set();
  const all = [];
  let start = sinceMs;

  for (let i = 0; i < FUNDING_MAX_PAGES; i++) {
    let page;
    try {
      page = await exchange.fetchFundingRateHistory(symbol, start, FUNDING_PAGE_LIMIT);
    } catch {
      break;
    }
    if (!page?.length) break;

    for (const rate of page) {
      const timestamp = num(rate.timestamp);
      if (timestamp >= sinceMs && timestamp <= nowMs && !seen.has(timestamp)) {
        seen.add(timestamp);
        all.push({ timestamp });
      }
    }
    const last = num(page[page.length - 1]?.timestamp);
    if (!last || last <= start || page.length < FUNDING_PAGE_LIMIT) break;
    start = last + 1;
  }
  return all.sort((a, b) => b.timestamp - a.timestamp);
}

function buildExpectedFundingRecords(
  records,
  schedule,
  intervalHours,
  anchorTimestamp,
  sinceMs,
  nowMs
) {
  const intervalMs = intervalHours * HOUR_MS;
  let expected = schedule.slice();

  if (!expected.length) {
    if (!intervalMs) return records;
    let anchor = num(anchorTimestamp);
    if (!anchor && records.length) anchor = num(records[0].timestamp);
    if (!anchor) return records;
    while (anchor > nowMs) anchor -= intervalMs;
    while (anchor + intervalMs <= nowMs) anchor += intervalMs;

    for (let ts = anchor; ts >= sinceMs; ts -= intervalMs) expected.push({ timestamp: ts });
    for (let ts = anchor + intervalMs; ts <= nowMs; ts += intervalMs) {
      expected.push({ timestamp: ts });
    }
  }

  const merged = [...new Map(
    expected.map((slot) => [num(slot.timestamp), {
      timestamp: num(slot.timestamp),
      amount: 0,
    }])
  ).values()].sort((a, b) => b.timestamp - a.timestamp);
  if (!merged.length) return records;

  for (const record of records) {
    let bestSlot = null;
    let bestDistance = Infinity;
    for (const slot of merged) {
      const distance = Math.abs(num(record.timestamp) - slot.timestamp);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestSlot = slot;
      }
    }
    if (bestSlot) {
      bestSlot.amount += num(record.amount);
    }
  }
  return merged;
}

async function processExchangePositions(name, exchange, nowMs, sinceMs) {
  let positions;
  try {
    positions = name === 'backpack'
      ? await fetchBackpackPositions(exchange)
      : (name === 'phemex' || name === 'mexc')
      ? await exchange.fetch_positions()
      : await exchange.fetchPositions();
  } catch {
    console.error(`${name} positions unavailable`);
    return [];
  }

  const open = positions.filter((p) => Math.abs(num(p.contracts)) > 0);
  if (!open.length) return [];

  const symbols = [...new Set(open.map((p) => p.symbol))];
  const [tickerCache, fundingRateCache, fundingIntervalCache] = await Promise.all([
    buildTickerCache(exchange, symbols),
    buildFundingRateCache(exchange, symbols),
    buildFundingIntervalCache(exchange, symbols),
  ]);
  const signFlip = NEGATIVE_FUNDING_SIGN.has(name) ? -1 : 1;

  const rows = await Promise.all(open.map(async (pos) => {
    const privateFunding = await fetchFundingWindow(exchange, pos.symbol, sinceMs, nowMs);
    const rate = fundingRateCache[pos.symbol];
    let intervalData = fundingIntervalCache[pos.symbol];
    let fundingIntervalHours =
      fundingIntervalFromRate(intervalData, exchange.markets[pos.symbol]) ||
      fundingIntervalFromRate(rate, exchange.markets[pos.symbol]) ||
      inferFundingInterval(privateFunding);
    let schedule = [];

    if (!fundingIntervalHours) {
      intervalData = await fetchFundingInterval(exchange, pos.symbol);
      fundingIntervalHours = fundingIntervalFromRate(
        intervalData,
        exchange.markets[pos.symbol]
      );
    }

    const nextFundingTimestamp = num(
      intervalData?.nextFundingTimestamp || rate?.nextFundingTimestamp
    );
    const fundingTimestamp = num(
      intervalData?.fundingTimestamp || rate?.fundingTimestamp
    );

    if (
      !fundingIntervalHours ||
      (!privateFunding.length && !nextFundingTimestamp && !fundingTimestamp)
    ) {
      schedule = await fetchFundingSchedule(exchange, pos.symbol, sinceMs, nowMs);
      if (!fundingIntervalHours) fundingIntervalHours = inferFundingInterval(schedule);
    }

    const anchorTimestamp =
      schedule[0]?.timestamp ||
      (nextFundingTimestamp && fundingIntervalHours
        ? nextFundingTimestamp - fundingIntervalHours * HOUR_MS
        : fundingTimestamp);
    const allFunding = buildExpectedFundingRecords(
      privateFunding,
      schedule,
      fundingIntervalHours,
      anchorTimestamp,
      sinceMs,
      nowMs
    );
    const totalFunding = allFunding.reduce((s, f) => s + num(f.amount), 0) * signFlip;

    let positionSize = pos.contracts;
    if (name === 'mexc' || name === 'bitget') {
      const market = exchange.markets[pos.symbol];
      const contractSize = market?.contractSize || 1;
      positionSize = (pos.contracts || 0) * contractSize;
    } else if (name === 'backpack') {
      positionSize = Math.abs(num(pos.contracts));
    }

    const ticker = tickerCache[pos.symbol];
    const computed = computePnL(pos, ticker, positionSize);
    const unrealizedPnl = name === 'backpack' && Number.isFinite(num(pos.unrealizedPnl))
      ? num(pos.unrealizedPnl)
      : computed.unrealizedPnl;
    const positionValue = computed.positionValue || num(pos.info?.netExposureNotional) || Math.abs(num(pos.info?.netCost));
    const currentPrice = computed.currentPrice;
    const side = computed.side;

    return {
      source: name,
      symbol: cleanSymbol(pos.symbol),
      rawSymbol: pos.symbol,
      side,
      currentPrice,
      entryPrice: pos.entryPrice || pos.entry_price || 0,
      positionSize,
      positionValue,
      unrealizedPnl,
      count: allFunding.length,
      fundingIntervalHours,
      totalFunding,
      fundingRecords: allFunding.map((f) => num(f.amount) * signFlip),
      startTime: toSGTime(sinceMs),
      endTime: toSGTime(nowMs),
    };
  }));

  return rows;
}

// ---------- 订单 ----------
function formatOrder(o, name, exchange) {
  const triggerPrice = num(
    o.triggerPrice || o.stopPrice ||
    o.info?.stopPrice || o.info?.triggerPrice || 0
  );
  const limitPrice = num(o.price);
  const orderType = String(o.type || o.info?.type || 'LIMIT').toUpperCase();

  let kind = 'LIMIT';
  if (/TAKE_PROFIT|TAKEPROFIT/.test(orderType)) kind = 'TP';
  else if (/STOP/.test(orderType)) kind = 'SL';
  else if (triggerPrice && !limitPrice) kind = 'TRIGGER';

  const displayPrice = (kind === 'LIMIT')
    ? (limitPrice || triggerPrice)
    : (triggerPrice || limitPrice);

  // MEXC 合约 amount 是张数 (contracts)；需要 × contractSize 转成币数
  // 保持和 position.positionSize 的换算一致（见 processExchangePositions）
  let amount = num(o.amount || o.info?.origQty || o.info?.quantity || 0);
  if ((name === 'mexc' || name === 'bitget') && exchange && o.symbol) {
    const market = exchange.markets?.[o.symbol];
    const contractSize = market?.contractSize;
    if (contractSize && contractSize !== 1) {
      amount = amount * contractSize;
    }
  }

  return {
    exchange: name,
    symbol: cleanSymbol(o.symbol),
    side: name === 'mexc' ? convertMexcOrderSide(o.side) : o.side,
    price: displayPrice,
    triggerPrice,
    limitPrice,
    amount,
    kind,
    orderType,
  };
}

async function fetchBackpackOpenOrders(exchange) {
  const orders = await backpackSignedRequest('api/v1/orders', 'orderQueryAll');
  return (orders || []).map((o) => ({
    info: o,
    exchange: 'backpack',
    symbol: backpackUnifiedSymbol(exchange, o.symbol),
    side: o.side === 'Bid' ? 'buy' : o.side === 'Ask' ? 'sell' : String(o.side || '').toLowerCase(),
    type: o.orderType,
    price: num(o.price || o.limitPrice),
    triggerPrice: num(
      o.triggerPrice ||
      o.stopLossTriggerPrice ||
      o.takeProfitTriggerPrice
    ),
    amount: num(o.quantity || o.triggerQuantity),
  }));
}

async function processExchangeOrders(name, exchange, positionRows) {
  const results = [];
  try {
    if (name === 'binance') {
      const posSymbols = [...new Set(
        positionRows.filter((p) => p.source === name)
          .map((p) => p.rawSymbol || `${p.symbol}/USDT:USDT`)
      )];

      const perSymbol = await Promise.all(posSymbols.map(async (s) => {
        const [normal, triggers] = await Promise.all([
          exchange.fetchOpenOrders(s).catch(() => []),
          exchange.fetchOpenOrders(s, undefined, undefined, { stop: true }).catch(() => []),
        ]);
        return [...normal, ...triggers];
      }));
      results.push(...perSymbol.flat().map((o) => formatOrder(o, name, exchange)));
    } else if (name === 'backpack') {
      const openOrders = await fetchBackpackOpenOrders(exchange);
      results.push(...openOrders.map((o) => formatOrder(o, name, exchange)));
    } else if (name === 'phemex' || name === 'bitget') {
      const posSymbols = [...new Set(
        positionRows.filter((p) => p.source === name)
          .map((p) => p.rawSymbol || `${p.symbol}/USDT:USDT`)
      )];
      const perSymbol = await Promise.all(
        posSymbols.map((s) => exchange.fetchOpenOrders(s).catch(() => []))
      );
      results.push(...perSymbol.flat().map((o) => formatOrder(o, name, exchange)));
    } else {
      const openOrders = await exchange.fetchOpenOrders().catch(() => []);
      results.push(...openOrders.map((o) => formatOrder(o, name, exchange)));
    }
  } catch {
    console.error(`${name} orders unavailable`);
  }

  // 过滤无效订单（价格和数量都为 0 → 已成交或无效记录）
  // Close-all conditional orders can report quantity 0 while retaining a valid trigger price.
  const supportsZeroQuantityTrigger = ['backpack', 'binance', 'phemex'].includes(name);
  return results.filter((o) =>
    (o.price > 0 || o.triggerPrice > 0) &&
    (o.amount > 0 || (supportsZeroQuantityTrigger && o.triggerPrice > 0))
  );
}

function dedupeOrders(orders) {
  const seen = new Set();
  return orders.filter((o) => {
    const key = `${o.exchange}-${o.symbol}-${o.side}-${o.price}-${o.triggerPrice}-${o.amount}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- 对冲健康度（3 类） ----------
// Class A: 无 TP/SL 挂单保护
// Class B: 资费 funding 亏损
// Class C: 多空 size 或 orders 数量不对齐（不含无 TP/SL 的重复警告）
function analyzeHedges(result) {
  const bySymbol = {};
  for (const r of result) {
    if (!bySymbol[r.symbol]) bySymbol[r.symbol] = { long: [], short: [] };
    if (r.side === 'long') bySymbol[r.symbol].long.push(r);
    else if (r.side === 'short') bySymbol[r.symbol].short.push(r);
  }

  const noProtection = []; // Class A
  const fundingLoss = []; // Class B
  const misaligned = [];  // Class C

  for (const [symbol, sides] of Object.entries(bySymbol)) {
    const longSize = sides.long.reduce((s, r) => s + Math.abs(r.positionSize), 0);
    const shortSize = sides.short.reduce((s, r) => s + Math.abs(r.positionSize), 0);
    const longOrderCount = sides.long.reduce((s, r) => s + (r.tpSlClose?.length || 0), 0);
    const shortOrderCount = sides.short.reduce((s, r) => s + (r.tpSlClose?.length || 0), 0);
    const totalOrderCount = longOrderCount + shortOrderCount;
    const netFunding =
      sides.long.reduce((s, r) => s + r.totalFunding, 0) +
      sides.short.reduce((s, r) => s + r.totalFunding, 0);

    const allEntries = [...sides.long, ...sides.short];
    const hasAnyOrder = allEntries.some((r) => r.tpSlClose?.length);

    // Class A: 无 TP/SL 挂单保护
    if (!hasAnyOrder && allEntries.length > 0) {
      noProtection.push({
        symbol, longSize, shortSize, netFunding,
        longCount: sides.long.length, shortCount: sides.short.length,
      });
    }

    // Class B: funding 亏损
    if (netFunding < -0.5) {
      fundingLoss.push({
        symbol, longSize, shortSize, netFunding,
        longFunding: sides.long.reduce((s, r) => s + r.totalFunding, 0),
        shortFunding: sides.short.reduce((s, r) => s + r.totalFunding, 0),
      });
    }

    // Class C: size 或 order 不对齐
    // 注意：不再限制"仅当有 TP/SL 保护时才检查"
    // ETH 这种无 TP/SL + Size 不对齐应同时在两个分类里显示
    {
      const hasPair = sides.long.length && sides.short.length;
      const problems = [];

      // 裸露敞口（单边）
      if (!hasPair && allEntries.length > 0) {
        if (sides.long.length) problems.push(`裸多单，无对冲空头`);
        else problems.push(`裸空单，无对冲多头`);
      }

      if (hasPair) {
        // Size 对齐检查：任何绝对差 > 浮点容差都报出来
        const absDiff = Math.abs(longSize - shortSize);
        const sizeDiffPct = absDiff / Math.max(longSize, shortSize, 1);
        if (absDiff > 1e-8) {
          const dp = (longSize < 1 || shortSize < 1) ? 4 : (longSize < 100 ? 2 : 0);
          const lFmt = longSize.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
          const sFmt = shortSize.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
          problems.push(
            `Size 不对齐: L=${lFmt} vs S=${sFmt} (Δ${(sizeDiffPct * 100).toFixed(3)}%)`
          );
        }

        // Order 数量对齐检查：只在至少有一边挂单时检查（双方都没挂单不算 "数量不一致"）
        if (hasAnyOrder && longOrderCount !== shortOrderCount) {
          problems.push(
            `Order 数量不对齐: long=${longOrderCount} 单 vs short=${shortOrderCount} 单`
          );
        }
      }

      if (problems.length) {
        misaligned.push({
          symbol, longSize, shortSize,
          longOrderCount, shortOrderCount, totalOrderCount,
          netFunding, problems,
        });
      }
    }
  }

  // 排序：funding 亏损按绝对值大排前，misaligned 按 size 差异大排前
  fundingLoss.sort((a, b) => a.netFunding - b.netFunding);
  misaligned.sort((a, b) => {
    const aDiff = Math.abs(a.longSize - a.shortSize) / Math.max(a.longSize, a.shortSize, 1);
    const bDiff = Math.abs(b.longSize - b.shortSize) / Math.max(b.longSize, b.shortSize, 1);
    return bDiff - aDiff;
  });
  noProtection.sort((a, b) => b.longSize + b.shortSize - (a.longSize + a.shortSize));

  return { noProtection, fundingLoss, misaligned };
}

// ---------- 主 ----------
async function buildFundingPayload() {
  const t0 = Date.now();
  const exchanges = await getExchanges();
  const nowMs = Date.now();
  const sinceMs = nowMs - FUNDING_WINDOW_MS;

  try {
    const relayRequested = requestedFundingRelayExchanges();
    const relayConfigured = Boolean(
      String(process.env.POSITION_RELAY_URL || '').trim()
      || String(process.env.POSITION_RELAY_TOKEN || '').trim()
      || String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL || '').trim()
      || String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || '').trim()
    );
    let relayRequestFailed = false;
    const relay = await fetchFundingRelay(nowMs, sinceMs).catch(() => {
      relayRequestFailed = true;
      console.error('Funding relay unavailable');
      return { exchanges: {}, failures: {} };
    });
    const relayNames = new Set(Object.keys(relay.exchanges));
    const exchangeList = Object.entries(exchanges).filter(([name]) => !relayNames.has(name));
    const hyperliquidPromise = fetchHyperliquidAccount(nowMs, sinceMs).catch((err) => {
      console.error('hyperliquid account unavailable');
      return { equity: emptyWallet(), positions: [], orders: [] };
    });
    const perExchangePromises = exchangeList.map(async ([name, exchange]) => {
      try { await exchange.loadMarkets(); }
      catch { console.error(`${name} markets unavailable`); }

      const [equity, positions] = await Promise.all([
        BALANCE_FETCHERS[name](exchange).catch(() => {
          console.error(`${name} balance unavailable`);
          return emptyWallet();
        }),
        processExchangePositions(name, exchange, nowMs, sinceMs),
      ]);
      return { name, equity, positions };
    });

    const [perExchange, hyperliquid] = await Promise.all([
      Promise.all(perExchangePromises),
      hyperliquidPromise,
    ]);

    const equityOverview = {};
    const result = [];
    for (const { name, equity, positions } of perExchange) {
      equityOverview[name] = equity;
      result.push(...positions);
    }
    for (const [name, value] of Object.entries(relay.exchanges)) {
      equityOverview[name] = value.equity;
      result.push(...value.positions);
    }
    equityOverview.hyperliquid = hyperliquid.equity;
    result.push(...hyperliquid.positions);

    const phemexUnrealized = result
      .filter((r) => r.source === 'phemex')
      .reduce((s, r) => s + (r.unrealizedPnl || 0), 0);
    if (equityOverview.phemex) {
      equityOverview.phemex.total += phemexUnrealized;
      equityOverview.phemex.unrealizedPnl = phemexUnrealized;
    }

    // Orders
    const orderPromises = exchangeList.map(([name, exchange]) =>
      processExchangeOrders(name, exchange, result)
    );
    const ordersPerExchange = await Promise.all(orderPromises);
    const relayOrders = Object.values(relay.exchanges).flatMap((value) => value.orders);
    const dedupedOrders = dedupeOrders([
      ...ordersPerExchange.flat(),
      ...relayOrders,
      ...hyperliquid.orders,
    ]);

    const orderIndex = new Map();
    for (const o of dedupedOrders) {
      const key = `${o.exchange}|${o.symbol.toUpperCase()}`;
      if (!orderIndex.has(key)) orderIndex.set(key, []);
      orderIndex.get(key).push({
        side: o.side,
        price: o.price,
        triggerPrice: o.triggerPrice,
        limitPrice: o.limitPrice,
        amount: o.amount,
        kind: o.kind,
        orderType: o.orderType,
      });
    }
    for (const pos of result) {
      const key = `${pos.source}|${pos.symbol.toUpperCase()}`;
      const related = orderIndex.get(key);
      if (related?.length) pos.tpSlClose = related;
    }

    // 健康分析放在 orders 挂完之后，才能拿到 order count
    const hedgeHealth = analyzeHedges(result);

    const totalEquity = Object.values(equityOverview).reduce(
      (s, ex) => s + (ex.total || 0), 0
    );

    const elapsed = Date.now() - t0;
    console.log(
      `✅ ${elapsed}ms | pos=${result.length} | noTP=${hedgeHealth.noProtection.length} | fundLoss=${hedgeHealth.fundingLoss.length} | misalign=${hedgeHealth.misaligned.length}`
    );

    return {
      success: true,
      result,
      equityOverview,
      totalEquity,
      hedgeHealth,
      relayStatus: {
        configured: relayConfigured,
        requested: relayRequested,
        received: Object.keys(relay.exchanges),
        failures: relayRequestFailed
          ? relayRequested
          : Object.keys(relay.failures || {}),
      },
      elapsedMs: elapsed,
    };
  } catch (e) {
    console.error('Funding payload failed');
    throw e;
  }
}

let fundingResponseCache;
let fundingResponsePromise;

async function fundingHandler(req, res) {
  const cacheSeconds = Math.max(30, Math.floor(RESPONSE_CACHE_TTL_MS / 1000));
  res.setHeader(
    'Cache-Control',
    `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 5}`
  );

  const cacheAgeMs = fundingResponseCache
    ? Date.now() - fundingResponseCache.storedAt
    : Infinity;
  if (fundingResponseCache && cacheAgeMs < RESPONSE_CACHE_TTL_MS) {
    res.setHeader('X-Funding-Cache', 'HIT');
    return res.status(200).json(fundingResponseCache.payload);
  }

  try {
    if (!fundingResponsePromise) {
      fundingResponsePromise = buildFundingPayload()
        .then((payload) => {
          fundingResponseCache = { storedAt: Date.now(), payload };
          return payload;
        })
        .finally(() => {
          fundingResponsePromise = null;
        });
    }

    const payload = await fundingResponsePromise;
    res.setHeader('X-Funding-Cache', 'MISS');
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

module.exports = fundingHandler;
module.exports.buildFundingPayload = buildFundingPayload;
module.exports.fetchFundingRelay = fetchFundingRelay;
