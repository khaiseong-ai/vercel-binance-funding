const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveWithDoh } = require("../lib/local-dns.js");

test("uses only IPv4 answers from a successful trusted DNS response", async () => {
  const addresses = await resolveWithDoh("api.example.test", async (url, options) => {
    assert.equal(url.hostname, "dns.google");
    assert.equal(url.searchParams.get("name"), "api.example.test");
    assert.equal(options.headers.accept, "application/dns-json");
    return Response.json({
      Status: 0,
      Answer: [
        { type: 5, data: "alias.example.test." },
        { type: 1, data: "203.0.113.7" },
        { type: 28, data: "2001:db8::1" },
        { type: 1, data: "203.0.113.7" }
      ]
    });
  });
  assert.deepEqual(addresses, ["203.0.113.7"]);
});

test("fails closed when trusted DNS has no IPv4 answer", async () => {
  await assert.rejects(
    () => resolveWithDoh("api.example.test", async () => Response.json({ Status: 0, Answer: [] })),
    /trusted_dns_unavailable_api_example_test/
  );
});
