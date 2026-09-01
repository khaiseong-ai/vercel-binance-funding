const test = require('node:test');
const assert = require('node:assert/strict');
const { buildExpectedFundingRecords } = require('../api/funding.js');

test('pads partial funding history to the complete three-day interval count', () => {
  const endTime = Date.parse('2026-09-01T00:30:00.000Z');
  const startTime = endTime - 72 * 60 * 60 * 1000;
  const latestSlot = Date.parse('2026-09-01T00:00:00.000Z');
  const partialSchedule = Array.from({ length: 32 }, (_, index) => ({
    timestamp: latestSlot - index * 60 * 60 * 1000
  }));

  const hourly = buildExpectedFundingRecords(
    [{ timestamp: latestSlot, amount: 1.25 }],
    partialSchedule,
    1,
    latestSlot,
    startTime,
    endTime
  );
  assert.equal(hourly.length, 72);
  assert.equal(hourly.reduce((sum, row) => sum + row.amount, 0), 1.25);
  assert.equal(hourly.filter((row) => row.amount === 0).length, 71);

  const eightHourlyZeros = buildExpectedFundingRecords(
    [],
    [],
    8,
    0,
    startTime,
    endTime
  );
  assert.equal(eightHourlyZeros.length, 9);
  assert.ok(eightHourlyZeros.every((row) => row.amount === 0));
});
