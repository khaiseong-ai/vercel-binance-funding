const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchFundingRelay } = require('../api/funding.js');

test('fetches and sanitizes Binance and Bybit funding relay data', async () => {
  const previousUrl = process.env.POSITION_RELAY_URL;
  const previousToken = process.env.POSITION_RELAY_TOKEN;
  const previousBinanceKey = process.env.BINANCE_API_KEY;
  const previousBinanceSecret = process.env.BINANCE_API_SECRET;
  const previousBybitKey = process.env.BYBIT_API_KEY;
  const previousBybitSecret = process.env.BYBIT_API_SECRET;
  const previousRelayExchanges = process.env.POSITION_RELAY_EXCHANGES;
  process.env.POSITION_RELAY_URL = 'https://relay.example/state?ignored=true';
  process.env.POSITION_RELAY_TOKEN = 'relay-token';
  process.env.BINANCE_API_KEY = 'binance-key';
  process.env.BINANCE_API_SECRET = 'binance-secret';
  process.env.BYBIT_API_KEY = 'bybit-key';
  process.env.BYBIT_API_SECRET = 'bybit-secret';
  process.env.POSITION_RELAY_EXCHANGES = 'binance,bybit';

  let captured;
  try {
    const result = await fetchFundingRelay(2000, 1000, async (url, options) => {
      captured = { url: String(url), options };
      return Response.json({
        ok: true,
        exchanges: {
          binance: {
            equity: { futures: { USDT: '12.5' }, privateField: 'hidden' },
            positions: [{
              symbol: 'BTCUSDT',
              rawSymbol: 'BTCUSDT',
              side: 'long',
              positionSize: '0.1',
              currentPrice: '100000',
              positionValue: '10000',
              fundingIntervalHours: '8',
              fundingRecords: ['0', '1.25'],
              totalFunding: '999',
              accountAlias: 'hidden'
            }],
            orders: [{
              symbol: 'BTCUSDT',
              side: 'sell',
              triggerPrice: '90000',
              amount: '0.1',
              kind: 'SL',
              privateField: 'hidden'
            }]
          },
          bybit: { equity: {}, positions: [], orders: [] },
          unexpected: { positions: [{ symbol: 'SECRET' }], orders: [] }
        }
      });
    });

    assert.equal(captured.url, 'https://relay.example/funding');
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.headers.authorization, 'Bearer relay-token');
    assert.deepEqual(JSON.parse(captured.options.body), {
      startTime: 1000,
      endTime: 2000,
      exchanges: ['binance', 'bybit'],
      credentials: {
        binance: { apiKey: 'binance-key', apiSecret: 'binance-secret' },
        bybit: { apiKey: 'bybit-key', apiSecret: 'bybit-secret' }
      }
    });
    assert.deepEqual(Object.keys(result.exchanges).sort(), ['binance', 'bybit']);
    assert.equal(result.exchanges.binance.positions[0].symbol, 'BTCUSDT');
    assert.equal(result.exchanges.binance.positions[0].count, 2);
    assert.equal(result.exchanges.binance.positions[0].totalFunding, 1.25);
    assert.deepEqual(result.exchanges.binance.positions[0].fundingRecords, [0, 1.25]);
    assert.doesNotMatch(JSON.stringify(result), /privateField|accountAlias|hidden|unexpected/);
  } finally {
    if (previousUrl === undefined) delete process.env.POSITION_RELAY_URL;
    else process.env.POSITION_RELAY_URL = previousUrl;
    if (previousToken === undefined) delete process.env.POSITION_RELAY_TOKEN;
    else process.env.POSITION_RELAY_TOKEN = previousToken;
    if (previousBinanceKey === undefined) delete process.env.BINANCE_API_KEY;
    else process.env.BINANCE_API_KEY = previousBinanceKey;
    if (previousBinanceSecret === undefined) delete process.env.BINANCE_API_SECRET;
    else process.env.BINANCE_API_SECRET = previousBinanceSecret;
    if (previousBybitKey === undefined) delete process.env.BYBIT_API_KEY;
    else process.env.BYBIT_API_KEY = previousBybitKey;
    if (previousBybitSecret === undefined) delete process.env.BYBIT_API_SECRET;
    else process.env.BYBIT_API_SECRET = previousBybitSecret;
    if (previousRelayExchanges === undefined) delete process.env.POSITION_RELAY_EXCHANGES;
    else process.env.POSITION_RELAY_EXCHANGES = previousRelayExchanges;
  }
});

test('requires a complete HTTPS funding relay configuration', async () => {
  const previousUrl = process.env.POSITION_RELAY_URL;
  const previousToken = process.env.POSITION_RELAY_TOKEN;
  try {
    process.env.POSITION_RELAY_URL = 'http://relay.example';
    process.env.POSITION_RELAY_TOKEN = 'relay-token';
    await assert.rejects(() => fetchFundingRelay(2000, 1000), /must use HTTPS/);

    process.env.POSITION_RELAY_URL = 'https://relay.example';
    delete process.env.POSITION_RELAY_TOKEN;
    await assert.rejects(() => fetchFundingRelay(2000, 1000), /configuration is incomplete/);
  } finally {
    if (previousUrl === undefined) delete process.env.POSITION_RELAY_URL;
    else process.env.POSITION_RELAY_URL = previousUrl;
    if (previousToken === undefined) delete process.env.POSITION_RELAY_TOKEN;
    else process.env.POSITION_RELAY_TOKEN = previousToken;
  }
});
