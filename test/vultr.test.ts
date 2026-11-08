import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VultrClient, VultrError } from "../src/vultr.js";

describe("VultrClient", () => {
  it("sends the bearer token and follows cursor pagination", async () => {
    const seen: { url: string; authorization: string | null; body?: string }[] = [];
    const pages = [
      { domains: [{ domain: "a.com", date_created: "2026-01-01", dns_sec: "disabled" }], meta: { links: { next: "cursor-2", prev: "" } } },
      { domains: [{ domain: "b.com", date_created: "2026-01-02", dns_sec: "enabled" }], meta: { links: { next: "", prev: "cursor-1" } } },
    ];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      const headers = new Headers(init?.headers);
      seen.push({
        url: url.href,
        authorization: headers.get("authorization"),
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      const page = pages.shift();
      return new Response(JSON.stringify(page ?? { domains: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new VultrClient({ apiKey: "secret-token", baseUrl: "https://vultr.test/v2", fetch: fetchImpl });
    const domains = await client.listDomains();

    assert.deepEqual(
      domains.map((domain) => domain.domain),
      ["a.com", "b.com"],
    );
    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.authorization, "Bearer secret-token");
    assert.equal(seen[0]?.url.includes("secret-token"), false);
    assert.match(seen[0]?.url ?? "", /per_page=500/);
    assert.match(seen[1]?.url ?? "", /cursor=cursor-2/);
  });

  it("posts json and surfaces the Vultr error message", async () => {
    let body = "";
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify({ error: "Invalid API token" }), { status: 401 });
    };
    const client = new VultrClient({ apiKey: "secret-token", baseUrl: "https://vultr.test/v2", fetch: fetchImpl });

    await assert.rejects(
      () => client.createDomain({ domain: "example.com", dns_sec: "enabled" }),
      (error: unknown) => {
        assert.ok(error instanceof VultrError);
        assert.equal(error.status, 401);
        assert.match(error.message, /Invalid API token/);
        assert.equal(error.message.includes("secret-token"), false);
        return true;
      },
    );
    assert.deepEqual(JSON.parse(body), { domain: "example.com", dns_sec: "enabled" });
  });

  it("redacts the api key from network errors", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("connect failed for secret-token");
    };
    const client = new VultrClient({ apiKey: "secret-token", baseUrl: "https://vultr.test/v2", fetch: fetchImpl });
    await assert.rejects(() => client.getAccount(), /\[redacted\]/);
  });

  it("accepts an empty delete response", async () => {
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 204 });
    const client = new VultrClient({ apiKey: "secret-token", baseUrl: "https://vultr.test/v2", fetch: fetchImpl });
    await client.deleteDomain("example.com");
  });
});

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  if (typeof input === "object" && input !== null && "url" in input && typeof input.url === "string") {
    return new URL(input.url);
  }
  throw new Error("Unsupported fetch input");
}
