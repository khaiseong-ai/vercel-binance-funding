const SHEET_WEBAPP_HOST = "script.google.com";

function buildFundingSheetSnapshot(payload, checkedAt = new Date().toISOString()) {
  if (!payload?.success || !Array.isArray(payload.result)) {
    throw new Error("funding payload is invalid");
  }

  const equity = Object.entries(payload.equityOverview || {}).map(([exchange, value]) => ({
    exchange,
    futuresUsdt: numberValue(value?.futures?.USDT),
    futuresUsdc: numberValue(value?.futures?.USDC),
    spotUsdt: numberValue(value?.spot?.USDT),
    spotUsdc: numberValue(value?.spot?.USDC),
    fundingUsdt: numberValue(value?.funding?.USDT),
    fundingUsdc: numberValue(value?.funding?.USDC),
    unrealizedPnl: numberValue(value?.unrealizedPnl),
    total: numberValue(value?.total)
  })).sort((left, right) => left.exchange.localeCompare(right.exchange));

  const positions = payload.result.map((row) => ({
    symbol: textValue(row?.symbol),
    source: textValue(row?.source),
    side: textValue(row?.side),
    positionSize: numberValue(row?.positionSize),
    currentPrice: numberValue(row?.currentPrice),
    entryPrice: numberValue(row?.entryPrice),
    positionValue: numberValue(row?.positionValue),
    unrealizedPnl: numberValue(row?.unrealizedPnl),
    count: Math.max(0, Math.trunc(numberValue(row?.count))),
    fundingIntervalHours: numberValue(row?.fundingIntervalHours),
    totalFunding: numberValue(row?.totalFunding),
    fundingRecords: Array.isArray(row?.fundingRecords)
      ? row.fundingRecords.map(numberValue)
      : [],
    orders: Array.isArray(row?.tpSlClose)
      ? row.tpSlClose.map((order) => ({
        side: textValue(order?.side),
        price: numberValue(order?.price),
        triggerPrice: numberValue(order?.triggerPrice),
        limitPrice: numberValue(order?.limitPrice),
        amount: numberValue(order?.amount),
        kind: textValue(order?.kind),
        orderType: textValue(order?.orderType)
      }))
      : [],
    startTime: textValue(row?.startTime),
    endTime: textValue(row?.endTime)
  })).sort((left, right) => left.symbol.localeCompare(right.symbol)
    || left.source.localeCompare(right.source));

  return {
    success: true,
    checkedAt,
    totalEquity: numberValue(payload.totalEquity),
    elapsedMs: Math.max(0, Math.trunc(numberValue(payload.elapsedMs))),
    equity,
    positions,
    hedgeHealth: sanitizeHealth(payload.hedgeHealth)
  };
}

async function postFundingSheetSnapshot(config, snapshot, fetchImpl = fetch) {
  const url = new URL(String(config?.url || ""));
  if (url.protocol !== "https:" || url.hostname !== SHEET_WEBAPP_HOST) {
    throw new Error("funding Sheet web app URL is invalid");
  }
  const secret = String(config?.secret || "").trim();
  if (!secret) throw new Error("funding Sheet secret is missing");

  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "writeAccountFunding", secret, snapshot }),
    redirect: "follow",
    signal: AbortSignal.timeout(120000)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(`funding Sheet write failed with HTTP ${response.status}`);
  }
  return body;
}

function sanitizeHealth(value) {
  const health = value && typeof value === "object" ? value : {};
  return {
    noProtection: sanitizeHealthRows(health.noProtection),
    fundingLoss: sanitizeHealthRows(health.fundingLoss),
    misaligned: sanitizeHealthRows(health.misaligned)
  };
}

function sanitizeHealthRows(value) {
  return Array.isArray(value) ? value.map((row) => ({
    symbol: textValue(row?.symbol),
    longSize: numberValue(row?.longSize),
    shortSize: numberValue(row?.shortSize),
    netFunding: numberValue(row?.netFunding),
    longFunding: numberValue(row?.longFunding),
    shortFunding: numberValue(row?.shortFunding),
    longOrderCount: Math.max(0, Math.trunc(numberValue(row?.longOrderCount))),
    shortOrderCount: Math.max(0, Math.trunc(numberValue(row?.shortOrderCount))),
    problems: Array.isArray(row?.problems) ? row.problems.map(textValue) : []
  })) : [];
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textValue(value) {
  return String(value ?? "");
}

module.exports = {
  buildFundingSheetSnapshot,
  postFundingSheetSnapshot
};
