import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { instanceHostsDomain, hostDomain, pickOperatingSystem, pickPlan } from "../src/host.js";
import type { Plan } from "../src/vultr.js";
import { FakeVultr } from "./fake-vultr.js";

const immediate: { sleep: (ms: number) => Promise<void>; now: () => number } = {
  sleep: async () => undefined,
  now: () => 0,
};

describe("hostDomain", () => {
  it("publishes a zone for an existing address without creating a server", async () => {
    const api = new FakeVultr();
    const result = await hostDomain(api, { domain: "Example.com", ip: "203.0.113.10", www: true }, immediate);

    assert.equal(result.domain, "example.com");
    assert.deepEqual(result.nameservers, ["ns1.vultr.com", "ns2.vultr.com"]);
    assert.equal(result.zone_created, true);
    assert.equal(result.instance, undefined);
    assert.deepEqual(
      result.records.map((record) => `${record.name} ${record.type} ${record.data} ${record.action}`),
      ["@ A 203.0.113.10 created", "www A 203.0.113.10 created"],
    );
    assert.equal(api.createdPayloads.length, 0);
    assert.match(result.next_steps.join("\n"), /does not register/);
  });

  it("updates an existing address record and skips www when asked", async () => {
    const api = new FakeVultr();
    await api.createDomain({ domain: "example.com" });
    await api.createRecord("example.com", { name: "", type: "A", data: "198.51.100.8", ttl: 300 });
    await api.createRecord("example.com", { name: "", type: "MX", data: "mail.example.com", ttl: 300, priority: 10 });

    const result = await hostDomain(api, { domain: "example.com", ip: "203.0.113.10", www: false }, immediate);
    const records = await api.listRecords("example.com");

    assert.equal(result.zone_created, false);
    assert.equal(result.records[0]?.action, "updated");
    assert.equal(result.records[0]?.previous_data, "198.51.100.8");
    assert.equal(records.filter((record) => record.type === "A").length, 1);
    assert.equal(records.find((record) => record.type === "MX")?.data, "mail.example.com");
  });

  it("refuses to guess between an address and a new server", async () => {
    const api = new FakeVultr();
    await assert.rejects(
      () => hostDomain(api, { domain: "example.com", ip: "203.0.113.10", provision: true }, immediate),
      /exactly one/,
    );
    assert.equal(api.createdPayloads.length, 0);
  });

  it("refuses to publish dns when the key lacks dns permission", async () => {
    const api = new FakeVultr();
    api.account.acls = ["provisioning"];
    await assert.rejects(() => hostDomain(api, { domain: "example.com", ip: "203.0.113.10" }, immediate), /dns permission/);
    assert.equal((await api.listDomains()).length, 0);
  });

  it("creates the cheapest cloud server, firewall, and dns records", async () => {
    const api = new FakeVultr();
    const clock = tickingClock();
    const result = await hostDomain(
      api,
      {
        domain: "example.com",
        provision: true,
        region: "lhr",
        sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTests user@host",
        dnsSec: true,
      },
      clock,
    );

    assert.equal(result.instance?.plan, "vc2-1c-1gb");
    assert.equal(result.instance?.region, "lhr");
    assert.equal(result.instance?.reused, false);
    assert.equal(result.instance?.monthly_cost, 5);
    assert.equal(result.instance?.default_password, "temporary-root-password");
    assert.match(result.billing_note ?? "", /\$5\/month/);
    assert.equal(result.dns_sec, "enabled");
    assert.equal(result.ds_records?.length, 1);
    assert.match(result.web_server, /nginx/);

    const payload = api.createdPayloads[0];
    assert.ok(payload);
    assert.equal(payload.plan, "vc2-1c-1gb");
    assert.equal(payload.os_id, 2284);
    assert.equal(payload.hostname, "example.com");
    assert.deepEqual(payload.tags, ["vultr-domain-mcp", "example.com"]);
    assert.equal(payload.sshkey_id?.length, 1);
    assert.ok(payload.firewall_group_id);
    const script = Buffer.from(payload.user_data ?? "", "base64").toString("utf8");
    assert.match(script, /^#cloud-config/);
    assert.match(script, /example\.com/);
    assert.match(script, /nginx/);

    const rules = await api.listFirewallRules(payload.firewall_group_id ?? "");
    assert.equal(rules.filter((rule) => rule.port === "80").length, 2);
    assert.equal(rules.filter((rule) => rule.port === "443").length, 2);
    assert.ok(result.records.some((record) => record.type === "AAAA"));

    const again = await hostDomain(api, { domain: "example.com", provision: true, region: "ewr" }, clock);
    assert.equal(api.createdPayloads.length, 1);
    assert.equal(again.instance?.reused, true);
    assert.equal(again.records.every((record) => record.action === "unchanged"), true);
  });

  it("waits until a new instance receives a public address", async () => {
    const api = new FakeVultr();
    api.ipDelayGets = 1;
    const result = await hostDomain(
      api,
      { domain: "example.com", provision: true, installWeb: false, openFirewall: false, waitForIpMs: 10_000 },
      tickingClock(),
    );
    assert.match(result.instance?.main_ip ?? "", /^203\.0\.113\./);
    assert.match(result.web_server, /without a web server/);
    assert.equal(api.createdPayloads[0]?.user_data, undefined);
    assert.equal(api.createdPayloads[0]?.firewall_group_id, undefined);
  });

  it("does not replace a firewall already attached to a server", async () => {
    const api = new FakeVultr();
    const existing = api.seedInstance({
      id: "inst-existing",
      label: "host-example.com",
      firewall_group_id: "fw-existing",
      main_ip: "203.0.113.50",
      tags: ["vultr-domain-mcp", "example.com"],
    });
    const result = await hostDomain(api, { domain: "example.com", instanceId: existing.id }, immediate);
    assert.equal(result.instance?.main_ip, "203.0.113.50");
    assert.equal(result.firewall?.id, "fw-existing");
    assert.match(result.firewall?.note ?? "", /existing firewall/);
    assert.equal(api.updates.length, 0);
    assert.match(result.web_server, /left unchanged/);
  });

  it("warns when the address is private", async () => {
    const api = new FakeVultr();
    const result = await hostDomain(api, { domain: "example.com", ip: "192.168.1.20" }, immediate);
    assert.match(result.private_address_warning ?? "", /private address/);
  });
});

describe("plan and operating system selection", () => {
  it("picks the cheapest vc2 plan in the region", () => {
    const plans: Plan[] = new FakeVultr().plans;
    assert.equal(pickPlan(plans, "ewr").id, "vc2-1c-1gb");
    assert.throws(() => pickPlan(plans, "ewr", "vc2-1c-1gb-missing"), /was not found/);
  });

  it("prefers the named ubuntu release over an older one", () => {
    const images = new FakeVultr().operatingSystems;
    assert.equal(pickOperatingSystem(images, "Ubuntu 24.04").id, 2284);
    assert.equal(pickOperatingSystem(images, "ubuntu").name.includes("24.04"), true);
  });
});

describe("instance matching", () => {
  it("recognizes servers this tool labeled", () => {
    const api = new FakeVultr();
    const instance = api.seedInstance({ id: "inst-1", label: "host-example.com" });
    assert.equal(instanceHostsDomain(instance, "example.com"), true);
    assert.equal(instanceHostsDomain(instance, "other.com"), false);
  });
});

function tickingClock(): { sleep: (ms: number) => Promise<void>; now: () => number; intervalMs: number } {
  let clock = 0;
  return {
    intervalMs: 1_000,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
}
