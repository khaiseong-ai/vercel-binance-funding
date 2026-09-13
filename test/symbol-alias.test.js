const assert = require('node:assert/strict');
const test = require('node:test');
const { cleanSymbol, symbolUnitMultiplier } = require('../api/funding.js');

test('normalizes 1000LUNC to LUNC', () => {
  assert.equal(cleanSymbol('1000LUNC'), 'LUNC');
  assert.equal(cleanSymbol('1000LUNC/USDT'), 'LUNC');
  assert.equal(symbolUnitMultiplier('1000LUNC/USDT:USDT'), 1000);
  assert.equal(symbolUnitMultiplier('LUNC/USDT:USDT'), 1);
});
