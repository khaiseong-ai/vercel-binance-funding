import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { postFundingSheetSnapshot } = require("../lib/funding-sheet.js");
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(scriptDirectory);
const defaultEnvPath = path.join(os.homedir(), "AppData", "Local", "ks-funding", "funding.env");
const envPath = process.argv[2] || process.env.FUNDING_LOCAL_ENV || defaultEnvPath;
if (fs.existsSync(envPath)) loadEnvFile(envPath);

const host = "127.0.0.1";
const port = Number(process.env.FUNDING_LOCAL_BUTTON_PORT || 17341);
const token = String(process.env.FUNDING_LOCAL_BUTTON_TOKEN || "").trim();
if (!token) {
  console.log(JSON.stringify({ error: "button_token_missing", envPath, envExists: fs.existsSync(envPath) }));
  throw new Error("FUNDING_LOCAL_BUTTON_TOKEN is missing");
}

let updateInProgress = false;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${host}:${port}`);
  if (request.method !== "GET") return sendJson(response, 405, { ok: false });
  if (url.pathname === "/health") return sendJson(response, 200, { ok: true, updating: updateInProgress });
  if (url.pathname !== "/update") return sendJson(response, 404, { ok: false });
  if (!matchesToken(url.searchParams.get("token"), token)) return sendJson(response, 401, { ok: false });
  if (updateInProgress) {
    return sendHtml(response, 409, "更新正在进行", "已有一次更新正在执行，请等待原来的页面完成。");
  }

  updateInProgress = true;
  const startedAt = Date.now();
  try {
    const result = await runFundingSnapshot();
    return sendHtml(
      response,
      200,
      "更新完成",
      `已写入 ${result.positions} 个持仓、${result.exchanges} 个交易所，用时 ${formatSeconds(Date.now() - startedAt)} 秒。`
    );
  } catch (error) {
    const reason = classifyFailure(error);
    let cleared = false;
    try {
      await clearFundingSheet();
      cleared = true;
    } catch (_clearError) {
      cleared = false;
    }
    return sendHtml(
      response,
      500,
      "更新失败",
      cleared
        ? `${reason}。旧数据已清空，并已记录本次检查时间。`
        : `${reason}。清空旧数据也失败，请查看本机日志。`
    );
  } finally {
    updateInProgress = false;
  }
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ ok: true, service: "ks-funding-local-button", host, port }));
});

function runFundingSnapshot() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scriptDirectory, "funding-sheet.mjs")], {
      cwd: projectRoot,
      env: { ...process.env, FUNDING_LOCAL_ENV: envPath },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 20 * 60 * 1000);
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(stderr || stdout || `snapshot_exit_${code}`));
      try {
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}";
        const result = JSON.parse(line);
        if (result.ok !== true) throw new Error("snapshot_result_invalid");
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function clearFundingSheet() {
  const url = String(process.env.FUNDING_SHEET_WEBAPP_URL || "").trim();
  const secret = String(process.env.FUNDING_SHEET_SECRET || "").trim();
  await postFundingSheetSnapshot({ url, secret }, {
    success: true,
    checkedAt: new Date().toISOString(),
    elapsedMs: 0,
    totalEquity: 0,
    equity: [],
    positions: [],
    hedgeHealth: { noProtection: [], fundingLoss: [], misaligned: [] }
  });
}

function matchesToken(candidate, expected) {
  const left = Buffer.from(String(candidate || ""));
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function classifyFailure(error) {
  const message = String(error?.message || "");
  if (/binance/i.test(message)) return "Binance unavailable";
  if (/bybit/i.test(message)) return "Bybit unavailable";
  if (/backpack/i.test(message)) return "Backpack unavailable";
  if (/mexc/i.test(message)) return "MEXC unavailable";
  if (/bitget/i.test(message)) return "Bitget unavailable";
  if (/phemex/i.test(message)) return "Phemex unavailable";
  if (/hyperliquid/i.test(message)) return "Hyperliquid unavailable";
  if (/Missing local configuration/i.test(message)) return "本地密钥配置不完整";
  return "本地抓取未完成";
}

function sendHtml(response, status, title, detail) {
  const body = "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    `<title>${escapeHtml(title)}</title>` +
    "<style>body{font:18px system-ui;margin:48px;color:#202124;max-width:760px}" +
    "h1{font-size:28px;letter-spacing:0}p{line-height:1.6}.ok{color:#137333}.bad{color:#b3261e}</style>" +
    `<h1 class=\"${status < 400 ? "ok" : "bad"}\">${escapeHtml(title)}</h1>` +
    `<p>${escapeHtml(detail)}</p><p>可以关闭此页面并返回 Google Sheet。</p></html>`;
  response.writeHead(status, securityHeaders("text/html; charset=utf-8"));
  response.end(body);
}

function sendJson(response, status, body) {
  response.writeHead(status, securityHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(body));
}

function securityHeaders(contentType) {
  return {
    "cache-control": "no-store",
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'"
  };
}

function appendBounded(current, chunk) {
  return (current + String(chunk)).slice(-12000);
}

function formatSeconds(milliseconds) {
  return Math.max(0, milliseconds / 1000).toFixed(1);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>\"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"
  })[character]);
}

function loadEnvFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!String(process.env[name] || "").trim()) process.env[name] = value.replace(/\\n/g, "\n");
  }
}
