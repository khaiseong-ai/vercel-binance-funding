const dns = require("node:dns");
const net = require("node:net");

const DOH_ENDPOINT = "https://dns.google/resolve";
const DEFAULT_HOSTS = [
  "fapi.binance.com",
  "dapi.binance.com",
  "eapi.binance.com",
  "papi.binance.com",
  "api.binance.com",
  "api.mexc.com",
  "api.bybit.com"
];

async function installTrustedDnsLookup(hosts = DEFAULT_HOSTS, fetchImpl = fetch) {
  const uniqueHosts = [...new Set(hosts.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
  const entries = await Promise.all(uniqueHosts.map(async (hostname) => [
    hostname,
    await resolveWithDoh(hostname, fetchImpl)
  ]));
  const addresses = new Map(entries);
  const counters = new Map();
  const originalLookup = dns.lookup.bind(dns);

  dns.lookup = function trustedLookup(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const settings = options || {};
    const candidates = addresses.get(String(hostname || "").toLowerCase());
    if (!candidates?.length) return originalLookup(hostname, settings, callback);

    const index = counters.get(hostname) || 0;
    const address = candidates[index % candidates.length];
    counters.set(hostname, index + 1);
    queueMicrotask(() => settings.all
      ? callback(null, [{ address, family: 4 }])
      : callback(null, address, 4));
  };

  return Object.fromEntries(entries.map(([hostname, values]) => [hostname, values.length]));
}

async function resolveWithDoh(hostname, fetchImpl) {
  const url = new URL(DOH_ENDPOINT);
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", "A");
  const response = await fetchImpl(url, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => null);
  const addresses = [...new Set((body?.Answer || [])
    .filter((answer) => Number(answer?.type) === 1 && net.isIP(String(answer?.data || "")) === 4)
    .map((answer) => String(answer.data)))];
  if (!response.ok || Number(body?.Status) !== 0 || addresses.length === 0) {
    throw new Error(`trusted_dns_unavailable_${hostname.replace(/[^a-z0-9]+/gi, "_")}`);
  }
  return addresses;
}

module.exports = { DEFAULT_HOSTS, installTrustedDnsLookup, resolveWithDoh };
