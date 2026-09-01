import crypto from "node:crypto";

let ed25519Promise;
async function getEd25519() {
  if (!ed25519Promise) ed25519Promise = import("@noble/curves/ed25519.js").then((module) => module.ed25519);
  return ed25519Promise;
}

function normalizeTimestamp(value) {
  let number = Number(value);
  if (!Number.isFinite(number)) number = Date.parse(String(value || ""));
  if (!Number.isFinite(number)) return 0;
  if (number > 1e17) number /= 1e6;
  else if (number > 1e14) number /= 1e3;
  return Math.trunc(number);
}

function authorized(req) {
  const expected = Buffer.from(process.env.WEEKLY_PNL_PROXY_SECRET || "");
  const actual = Buffer.from(String(req.headers["x-weekly-pnl-secret"] || ""));
  return expected.length > 0 && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function backpackSignedGet(endpoint, instruction, params = {}) {
  const timestamp = String(Date.now());
  const window = "60000";
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([left], [right]) => left.localeCompare(right));
  const query = entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
  const payload = `instruction=${instruction}${query ? `&${query}` : ""}&timestamp=${timestamp}&window=${window}`;
  const ed25519 = await getEd25519();
  const signature = Buffer.from(
    ed25519.sign(Buffer.from(payload), Buffer.from(process.env.BACKPACK_API_SECRET, "base64"))
  ).toString("base64");
  const response = await fetch(`https://api.backpack.exchange${endpoint}${query ? `?${query}` : ""}`, {
    headers: {
      "X-API-Key": process.env.BACKPACK_API_KEY,
      "X-Signature": signature,
      "X-Timestamp": timestamp,
      "X-Window": window
    }
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Backpack returned HTTP ${response.status}`); }
  if (!response.ok) throw new Error(`Backpack returned HTTP ${response.status}: ${json.message || json.msg || "request failed"}`);
  return json;
}

function sideOf(row) {
  const explicit = String(row.side || "").toLowerCase();
  if (["long", "short"].includes(explicit)) return explicit;
  const entry = Number(row.entryPrice || 0);
  const close = Number(row.closingPrice || 0);
  const pricePnl = Number(row.cumulativePnlRealized || 0);
  if (entry !== close && pricePnl !== 0) return Math.sign(close - entry) === Math.sign(pricePnl) ? "long" : "short";
  return Number(row.closedVolume || row.netQuantity || 0) < 0 ? "short" : "long";
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
  const startMs = Date.parse(String(req.query.start || ""));
  const endMs = Date.parse(String(req.query.end || ""));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs || endMs - startMs > 14 * 86400000) {
    return res.status(400).json({ error: "Invalid time range" });
  }

  try {
    const positions = [];
    for (let offset = 0; offset < 10000; offset += 1000) {
      const rows = await backpackSignedGet("/wapi/v1/history/position", "positionHistoryQueryAll", {
        state: "Closed", limit: 1000, offset, sortDirection: "Desc"
      });
      if (!Array.isArray(rows)) throw new Error("Backpack position history returned invalid data");
      positions.push(...rows);
      if (rows.length < 1000 || rows.every((row) => normalizeTimestamp(row.closedAt) < startMs)) break;
    }
    const selected = positions.filter((row) => {
      const closedAt = normalizeTimestamp(row.closedAt);
      return closedAt >= startMs && closedAt <= endMs;
    });
    if (!selected.length) return res.status(200).json({ success: true, result: [] });

    const settlementByPosition = new Map();
    const oldestOpen = Math.min(...selected.map((row) => normalizeTimestamp(row.openedAt) || startMs));
    for (let offset = 0; offset < 20000; offset += 1000) {
      const rows = await backpackSignedGet("/wapi/v1/history/settlement", "settlementHistoryQueryAll", {
        limit: 1000, offset, sortDirection: "Desc"
      });
      if (!Array.isArray(rows)) throw new Error("Backpack settlement history returned invalid data");
      for (const row of rows) {
        const positionId = String(row.positionId || "");
        if (!positionId) continue;
        const bucket = settlementByPosition.get(positionId) || [];
        bucket.push(row);
        settlementByPosition.set(positionId, bucket);
      }
      if (rows.length < 1000 || rows.every((row) => normalizeTimestamp(row.timestamp) < oldestOpen)) break;
    }

    const result = selected.map((row) => {
      const positionId = String(row.id || row.positionId || "");
      const settlements = settlementByPosition.get(positionId) || [];
      const fundingPnl = settlements
        .filter((item) => item.source === "FundingPayment")
        .reduce((sum, item) => sum + Number(item.quantity || 0), 0);
      const fallbackPnl = Number(row.cumulativePnlRealized || 0) +
        Number(row.fundingQuantity || 0) - Math.abs(Number(row.fees || 0));
      return {
        exchange: "backpack",
        symbol: row.symbol,
        side: sideOf(row),
        pnl: settlements.length
          ? settlements.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
          : fallbackPnl,
        pricePnl: Number(row.cumulativePnlRealized || 0),
        fundingPnl,
        qty: Math.abs(Number(row.closedVolume || row.netExposureQuantity || row.netQuantity || 0)),
        entryPrice: Number(row.entryPrice || 0),
        closePrice: Number(row.closingPrice || 0),
        openedAt: normalizeTimestamp(row.openedAt),
        closedAt: normalizeTimestamp(row.closedAt),
        id: positionId
      };
    });
    return res.status(200).json({ success: true, result });
  } catch (error) {
    return res.status(502).json({ success: false, error: String(error?.message || error) });
  }
}
