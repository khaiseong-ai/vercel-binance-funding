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
  const previousOidcUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const previousOidcToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
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
    if (previousOidcUrl === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_URL = previousOidcUrl;
    if (previousOidcToken === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = previousOidcToken;
  }
});

test('requires a complete HTTPS funding relay configuration', async () => {
  const previousUrl = process.env.POSITION_RELAY_URL;
  const previousToken = process.env.POSITION_RELAY_TOKEN;
  const previousOidcUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const previousOidcToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  try {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
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
    if (previousOidcUrl === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_URL = previousOidcUrl;
    if (previousOidcToken === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = previousOidcToken;
  }
});

test('prefers a short-lived GitHub Actions OIDC token for the relay', async () => {
  const names = [
    'POSITION_RELAY_URL',
    'POSITION_RELAY_TOKEN',
    'POSITION_RELAY_EXCHANGES',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN'
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.POSITION_RELAY_URL = 'https://relay.example/state';
  process.env.POSITION_RELAY_TOKEN = 'fallback-token';
  process.env.POSITION_RELAY_EXCHANGES = 'bybit';
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://oidc.actions.test/token?api-version=2';
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'request-token';

  let oidcCalls = 0;
  let relayCalls = 0;
  try {
    const result = await fetchFundingRelay(2000, 1000, async (input, options) => {
      const url = new URL(input);
      if (url.hostname === 'oidc.actions.test') {
        oidcCalls += 1;
        assert.equal(url.searchParams.get('audience'), 'position-relay');
        assert.equal(options.headers.authorization, 'Bearer request-token');
        return Response.json({ value: 'short-lived-jwt' });
      }
      relayCalls += 1;
      assert.equal(options.headers.authorization, 'Bearer short-lived-jwt');
      return Response.json({
        ok: true,
        exchanges: { bybit: { equity: {}, positions: [], orders: [] } }
      });
    });
    assert.equal(oidcCalls, 1);
    assert.equal(relayCalls, 1);
    assert.deepEqual(Object.keys(result.exchanges), ['bybit']);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
