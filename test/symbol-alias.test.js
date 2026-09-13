const assert = require('node:assert/strict');
const test = require('node:test');
const { cleanSymbol } = require('../api/funding.js');

test('normalizes 1000LUNC to LUNC', () => {
  assert.equal(cleanSymbol('1000LUNC'), 'LUNC');
  assert.equal(cleanSymbol('1000LUNC/USDT'), 'LUNC');
});
