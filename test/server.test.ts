import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src/server.js";
import { FakeVultr } from "./fake-vultr.js";

describe("MCP server", () => {
  it("lists the hosting tool and publishes a domain", async () => {
    const api = new FakeVultr();
    const { client, close } = await connect(api);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      assert.ok(names.includes("host-domain"));
      assert.ok(names.includes("check-account"));
      assert.ok(names.includes("delete-instance"));

      const account = JSON.parse(text(await client.callTool({ name: "check-account", arguments: {} })));
      assert.equal(account.permissions.dns, true);

      const hosted = JSON.parse(
        text(
          await client.callTool({
            name: "host-domain",
            arguments: { domain: "example.com", ip: "203.0.113.10" },
          }),
        ),
      );
      assert.deepEqual(hosted.nameservers, ["ns1.vultr.com", "ns2.vultr.com"]);
      assert.equal(hosted.domain, "example.com");

      const denied = await client.callTool({ name: "delete-domain", arguments: { domain: "example.com" } });
      assert.equal(denied.isError, true);
      assert.match(text(denied), /confirm/i);
      assert.equal((await api.listDomains()).length, 1);

      const removed = JSON.parse(
        text(await client.callTool({ name: "delete-domain", arguments: { domain: "example.com", confirm: true } })),
      );
      assert.equal(removed.deleted, "example.com");
      assert.equal((await api.listDomains()).length, 0);
    } finally {
      await close();
    }
  });

  it("rejects a new server until billing is acknowledged", async () => {
    const api = new FakeVultr();
    const { client, close } = await connect(api);
    try {
      const denied = await client.callTool({
        name: "host-domain",
        arguments: { domain: "example.com", provision: true },
      });
      assert.equal(denied.isError, true);
      assert.match(text(denied), /acknowledge_billing/);
      assert.equal(api.createdPayloads.length, 0);
    } finally {
      await close();
    }
  });

  it("requires a priority for mail records", async () => {
    const api = new FakeVultr();
    const { client, close } = await connect(api);
    try {
      const denied = await client.callTool({
        name: "create-record",
        arguments: { domain: "example.com", name: "@", type: "MX", data: "mail.example.com" },
      });
      assert.equal(denied.isError, true);
      assert.match(text(denied), /priority/);
    } finally {
      await close();
    }
  });

  it("exposes the hosting guide as a resource", async () => {
    const api = new FakeVultr();
    const { client, close } = await connect(api);
    try {
      const guide = await client.readResource({ uri: "vultr://domain-hosting" });
      const textBlock = guide.contents[0];
      assert.ok(textBlock && "text" in textBlock);
      assert.match(String(textBlock.text), /ns1\.vultr\.com/);
    } finally {
      await close();
    }
  });
});

async function connect(api: FakeVultr): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createServer(api);
  const client = new Client({ name: "test-harness", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function text(result: { content?: unknown; isError?: boolean }): string {
  if (!Array.isArray(result.content)) throw new Error("tool result has no content");
  const block = result.content[0];
  if (!block || typeof block !== "object" || !("text" in block) || typeof block.text !== "string") {
    throw new Error("tool result has no text");
  }
  return block.text;
}
