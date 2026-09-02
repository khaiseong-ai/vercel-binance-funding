import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildFundingPayload } = require("../api/funding.js");
const {
  assertFundingRelayCoverage,
  buildFundingSheetSnapshot,
  postFundingSheetSnapshot
} = require("../lib/funding-sheet.js");
const { installTrustedDnsLookup } = require("../lib/local-dns.js");

const defaultEnvPath = path.join(os.homedir(), "AppData", "Local", "ks-funding", "funding.env");
const envPath = process.env.FUNDING_LOCAL_ENV || defaultEnvPath;
if (fs.existsSync(envPath)) loadEnvFile(envPath);

const required = [
  "BINANCE_API_KEY", "BINANCE_API_SECRET",
  "BYBIT_API_KEY", "BYBIT_API_SECRET",
  "MEXC_API_KEY", "MEXC_API_SECRET",
  "BITGET_API_KEY", "BITGET_API_SECRET",
  "PHEMEX_API_KEY", "PHEMEX_API_SECRET",
  "BACKPACK_API_KEY", "BACKPACK_API_SECRET",
  "HYPERLIQUID_WALLET",
  "FUNDING_SHEET_WEBAPP_URL", "FUNDING_SHEET_SECRET"
];
const missing = required.filter((name) => !String(process.env[name] || "").trim());
if (!String(process.env.BITGET_API_PASSWORD || process.env.BITGET_API_PASSPHRASE || "").trim()) {
  missing.push("BITGET_API_PASSWORD or BITGET_API_PASSPHRASE");
}
if (missing.length > 0) {
  throw new Error(`Missing local configuration: ${missing.join(", ")}`);
}

if (!process.env.BITGET_API_PASSWORD && process.env.BITGET_API_PASSPHRASE) {
  process.env.BITGET_API_PASSWORD = process.env.BITGET_API_PASSPHRASE;
}

await installTrustedDnsLookup();
const coverageWarnings = [];
const originalConsoleError = console.error.bind(console);
console.error = (...values) => {
  const warning = values.map((value) => String(value)).join(" ").trim();
  if (warning) coverageWarnings.push(warning);
  originalConsoleError(...values);
};
const payload = await buildFundingPayload();
if (coverageWarnings.length > 0) {
  throw new Error(`Funding coverage incomplete: ${coverageWarnings.join("; ")}`);
}
assertFundingRelayCoverage(payload);
const snapshot = buildFundingSheetSnapshot(payload);
if (snapshot.positions.length === 0 && snapshot.totalEquity === 0) {
  throw new Error("Funding snapshot is empty; Sheet was not changed");
}

const result = await postFundingSheetSnapshot({
  url: process.env.FUNDING_SHEET_WEBAPP_URL,
  secret: process.env.FUNDING_SHEET_SECRET
}, snapshot);

console.log(JSON.stringify({
  ok: true,
  checkedAt: snapshot.checkedAt,
  positions: snapshot.positions.length,
  exchanges: snapshot.equity.length,
  rowsWritten: Number(result.rowsWritten || 0)
}));

function loadEnvFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(name in process.env)) process.env[name] = value.replace(/\\n/g, "\n");
  }
}
