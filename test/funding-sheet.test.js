const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildFundingSheetSnapshot,
  postFundingSheetSnapshot
} = require("../lib/funding-sheet.js");

test("builds a sanitized funding Sheet snapshot", () => {
  const snapshot = buildFundingSheetSnapshot({
    success: true,
    totalEquity: "25.5",
    elapsedMs: 321,
    equityOverview: {
      binance: { futures: { USDT: "20" }, spot: { USDT: 5 }, funding: { USDT: 0.5 }, total: 25.5 }
    },
    result: [{
      symbol: "BTC",
      source: "binance",
      side: "long",
      positionSize: "0.1",
      currentPrice: "100000",
      count: 9,
      fundingIntervalHours: 8,
      totalFunding: "1.25",
      fundingRecords: ["0", "1.25"],
      tpSlClose: [{ side: "sell", triggerPrice: "90000", amount: "0.1", kind: "SL" }]
    }],
    hedgeHealth: { fundingLoss: [{ symbol: "BTC", netFunding: "-1" }] }
  }, "2026-09-01T00:00:00.000Z");

  assert.equal(snapshot.totalEquity, 25.5);
  assert.equal(snapshot.positions[0].fundingRecords[0], 0);
  assert.equal(snapshot.positions[0].orders[0].triggerPrice, 90000);
  assert.equal(snapshot.hedgeHealth.fundingLoss[0].netFunding, -1);
});

test("posts only to an authenticated Apps Script web app", async () => {
  let request;
  const result = await postFundingSheetSnapshot({
    url: "https://script.google.com/macros/s/test/exec",
    secret: "configured"
  }, { success: true }, async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ ok: true, rowsWritten: 4 }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });

  assert.equal(result.rowsWritten, 4);
  assert.equal(JSON.parse(request.options.body).secret, "configured");
  await assert.rejects(
    () => postFundingSheetSnapshot({ url: "https://example.com/write", secret: "x" }, {}),
    /URL is invalid/
  );
});
