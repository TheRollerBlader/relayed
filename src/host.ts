import { placeholderUserData } from "./cloud-init.js";
import {
  assertIpv4,
  assertIpv6,
  displayRecordName,
  isPrivateIpv4,
  normalizeDomain,
  relativeRecordName,
  sameRecordName,
} from "./domain.js";
import {
  requireAcl,
  type Account,
  type DnsRecord,
  type FirewallGroup,
  type FirewallRule,
  type Instance,
  type OsImage,
  type Plan,
  type RecordWrite,
  type SshKey,
  type VultrApi,
} from "./vultr.js";

export const VULTR_NAMESERVERS = ["ns1.vultr.com", "ns2.vultr.com"] as const;
export const MANAGED_TAG = "vultr-domain-mcp";

const OPENSSH_KEY =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh.com|sk-ecdsa-sha2-nistp256@openssh.com)\s+\S+/;

const WEB_RULES: readonly FirewallRule[] = [
  { ip_type: "v4", protocol: "tcp", port: "22", subnet: "0.0.0.0", subnet_size: 0, notes: "SSH" },
  { ip_type: "v4", protocol: "tcp", port: "80", subnet: "0.0.0.0", subnet_size: 0, notes: "HTTP" },
  { ip_type: "v4", protocol: "tcp", port: "443", subnet: "0.0.0.0", subnet_size: 0, notes: "HTTPS" },
  { ip_type: "v4", protocol: "icmp", subnet: "0.0.0.0", subnet_size: 0, notes: "ICMP" },
  { ip_type: "v6", protocol: "tcp", port: "22", subnet: "::", subnet_size: 0, notes: "SSH" },
  { ip_type: "v6", protocol: "tcp", port: "80", subnet: "::", subnet_size: 0, notes: "HTTP" },
  { ip_type: "v6", protocol: "tcp", port: "443", subnet: "::", subnet_size: 0, notes: "HTTPS" },
  { ip_type: "v6", protocol: "icmp", subnet: "::", subnet_size: 0, notes: "ICMP" },
];

export interface HostDomainInput {
  domain: string;
  ip?: string;
  ipv6?: string;
  instanceId?: string;
  provision?: boolean;
  region?: string;
  plan?: string;
  os?: string;
  sshKeyId?: string;
  sshPublicKey?: string;
  www?: boolean;
  ttl?: number;
  dnsSec?: boolean;
  openFirewall?: boolean;
  installWeb?: boolean;
  waitForIpMs?: number;
}

export interface RecordChange {
  id: string;
  name: string;
  type: string;
  data: string;
  action: "created" | "updated" | "unchanged";
  previous_data?: string;
  duplicate_ids?: string[];
}

export interface HostDomainResult {
  domain: string;
  nameservers: readonly string[];
  zone_created: boolean;
  dns_sec: string;
  ds_records?: string[];
  records: RecordChange[];
  instance?: {
    id: string;
    region: string;
    plan: string;
    os: string;
    main_ip: string;
    v6_main_ip: string;
    status: string;
    label: string;
    hostname: string;
    reused: boolean;
    monthly_cost?: number;
    default_password?: string;
  };
  firewall?: { id: string; attached: boolean; note: string };
  web_server: string;
  private_address_warning?: string;
  billing_note?: string;
  next_steps: string[];
}

export interface HostDomainOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
}

export async function hostDomain(
  api: VultrApi,
  input: HostDomainInput,
  options: HostDomainOptions = {},
): Promise<HostDomainResult> {
  const domain = normalizeDomain(input.domain);
  assertOneSource(input);
  const ttl = input.ttl ?? 300;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) {
    throw new Error("ttl must be a whole number of seconds from 60 through 86400.");
  }

  const account = await api.getAccount();
  requireAcl(
    account,
    "dns",
    "This API key cannot manage DNS (missing the dns permission). Create a key that includes DNS.",
  );

  const includeWww = input.www !== false;
  let ipv4 = input.ip ? assertIpv4(input.ip) : undefined;
  let ipv6 = input.ipv6 ? assertIpv6(input.ipv6) : undefined;
  let instanceSummary: HostDomainResult["instance"];
  let firewall: HostDomainResult["firewall"];
  let webServer = "Not installed. No server was created or changed.";
  let billingNote: string | undefined;

  if (input.instanceId) {
    const instance = await waitForPublicIpv4(api, input.instanceId, options, input.waitForIpMs);
    ipv4 = assertIpv4(instance.main_ip);
    if (!ipv6 && instance.v6_main_ip) ipv6 = instance.v6_main_ip;
    const attached = await attachWebFirewall(api, domain, instance, input.openFirewall !== false);
    firewall = attached.firewall;
    instanceSummary = summarizeHostedInstance(instance, false);
    webServer = "Not installed. The existing server was left unchanged.";
  } else if (input.provision) {
    requireAcl(
      account,
      "provisioning",
      "This API key cannot create servers (missing the provisioning permission). Point the domain at an existing IP, or use a key that can provision instances.",
    );
    const provisioned = await provisionServer(api, account, domain, input, options);
    ipv4 = provisioned.ipv4;
    if (!ipv6 && provisioned.instance.v6_main_ip) ipv6 = provisioned.instance.v6_main_ip;
    instanceSummary = provisioned.summary;
    firewall = provisioned.firewall;
    webServer = provisioned.webServer;
    billingNote = provisioned.billingNote;
  }

  if (!ipv4) throw new Error("No public IPv4 address is available to publish.");

  const zone = await ensureZone(api, domain, input.dnsSec === true);
  const names = includeWww ? ["", "www"] : [""];
  const records: RecordChange[] = [];
  for (const name of names) {
    records.push(await upsertRecord(api, domain, { name, type: "A", data: ipv4, ttl }));
    if (ipv6) {
      records.push(await upsertRecord(api, domain, { name, type: "AAAA", data: ipv6, ttl }));
    }
  }

  let dsRecords: string[] | undefined;
  if (zone.dnsSec === "enabled") {
    dsRecords = await api.getDnssec(domain);
  }

  const nextSteps = [
    "Vultr hosts DNS for a domain you already own. It does not register or sell the domain name.",
    `At your domain registrar, set the nameservers to ${VULTR_NAMESERVERS[0]} and ${VULTR_NAMESERVERS[1]}.`,
    "Nameserver changes often finish within a few minutes, but they can take up to 48 hours.",
    "Existing MX and other records were left in place. This only created or updated A and AAAA records for the apex and www.",
  ];
  if (webServer.startsWith("Installed")) {
    nextSteps.push(
      `After ${domain} resolves, http://${domain} should show a placeholder page. HTTPS is not configured. Once DNS points at this server, install a certificate there.`,
    );
  }
  if (dsRecords && dsRecords.length > 0) {
    nextSteps.push("DNSSEC is enabled. Add the DS records in this result at your registrar, or resolvers that validate DNSSEC will fail the domain.");
  }
  if (instanceSummary?.default_password) {
    nextSteps.push(
      "The root password in this result is shown only this once. Sign in with SSH and change it. This MCP server does not store it.",
    );
  }
  if (firewall?.attached) {
    nextSteps.push("SSH on port 22 is open to the internet. Key login is safer than a password. Tighten that rule later if you do not need it open.");
  }

  return {
    domain,
    nameservers: VULTR_NAMESERVERS,
    zone_created: zone.created,
    dns_sec: zone.dnsSec,
    ...(dsRecords ? { ds_records: dsRecords } : {}),
    records,
    ...(instanceSummary ? { instance: instanceSummary } : {}),
    ...(firewall ? { firewall } : {}),
    web_server: webServer,
    ...(isPrivateIpv4(ipv4)
      ? {
          private_address_warning: `${ipv4} is a private address. The public internet cannot reach it.`,
        }
      : {}),
    ...(billingNote ? { billing_note: billingNote } : {}),
    next_steps: nextSteps,
  };
}

export function assertOneSource(input: { ip?: string; instanceId?: string; provision?: boolean }): void {
  const chosen = [Boolean(input.ip), Boolean(input.instanceId), Boolean(input.provision)].filter(Boolean);
  if (chosen.length !== 1) {
    throw new Error("Provide exactly one of ip, instance_id, or provision: true.");
  }
}

export function pickPlan(plans: readonly Plan[], region: string, planId?: string): Plan {
  if (planId) {
    const plan = plans.find((item) => item.id === planId);
    if (!plan) throw new Error(`Plan "${planId}" was not found. Call list-plans.`);
    if (!plan.locations.includes(region)) {
      const where = plan.locations.length > 0 ? plan.locations.join(", ") : "no regions";
      throw new Error(`Plan "${planId}" is not available in region ${region}. It is offered in: ${where}.`);
    }
    return plan;
  }

  const candidates = plans.filter(
    (plan) => plan.type === "vc2" && plan.locations.includes(region) && plan.monthly_cost > 0,
  );
  const cheapest = [...candidates].sort(
    (left, right) => left.monthly_cost - right.monthly_cost || left.ram - right.ram || left.id.localeCompare(right.id),
  )[0];
  if (!cheapest) {
    throw new Error(
      `No Cloud Compute (vc2) plan is available in ${region}. Call list-plans for that region, or pass a plan id.`,
    );
  }
  return cheapest;
}

export function pickOperatingSystem(images: readonly OsImage[], query: string): OsImage {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new Error("Operating system search text is empty.");
  const matches = images.filter((image) => image.name.toLowerCase().includes(needle));
  if (matches.length === 0) {
    throw new Error(`No operating system matched "${query}". Call list-operating-systems to see names.`);
  }
  const x64 = matches.filter((image) => image.arch === "x64");
  const pool = x64.length > 0 ? x64 : matches;
  const chosen = [...pool].sort((left, right) => right.name.localeCompare(left.name) || left.id - right.id)[0];
  if (!chosen) throw new Error(`No operating system matched "${query}".`);
  return chosen;
}

export async function waitForPublicIpv4(
  api: VultrApi,
  instanceId: string,
  options: HostDomainOptions = {},
  timeoutMs = 120_000,
): Promise<Instance> {
  const intervalMs = options.intervalMs ?? 3_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let latest = await api.getInstance(instanceId);
  while (!isReadyIpv4(latest.main_ip)) {
    if (now() >= deadline) {
      throw new Error(
        `Instance ${instanceId} is ${latest.status} but has no public IPv4 yet (${latest.main_ip || "none"}). Wait until it is active, then run host-domain again with instance_id "${instanceId}".`,
      );
    }
    await sleep(intervalMs);
    latest = await api.getInstance(instanceId);
  }
  return latest;
}

async function provisionServer(
  api: VultrApi,
  account: Account,
  domain: string,
  input: HostDomainInput,
  options: HostDomainOptions,
): Promise<{
  ipv4: string;
  instance: Instance;
  summary: NonNullable<HostDomainResult["instance"]>;
  firewall?: HostDomainResult["firewall"];
  webServer: string;
  billingNote: string;
}> {
  const existing = await findManagedInstance(api, domain);
  if (existing) {
    const ready = isReadyIpv4(existing.main_ip)
      ? existing
      : await waitForPublicIpv4(api, existing.id, options, input.waitForIpMs);
    const attached = await attachWebFirewall(api, domain, ready, input.openFirewall !== false);
    return {
      ipv4: assertIpv4(ready.main_ip),
      instance: ready,
      summary: summarizeHostedInstance(ready, true),
      firewall: attached.firewall,
      webServer: "Not installed. Reused the existing server and left its operating system unchanged.",
      billingNote: `Reused instance ${ready.id}. No additional server was created. A halted Vultr instance is still billed until you delete it.`,
    };
  }

  const region = (input.region ?? "ewr").trim().toLowerCase();
  const regions = await api.listRegions();
  if (!regions.some((item) => item.id === region)) {
    throw new Error(`Unknown region "${region}". Call list-regions for ids such as ewr, lhr, or ams.`);
  }
  const plans = await api.listPlans(input.plan ? undefined : "vc2");
  const plan = pickPlan(plans, region, input.plan);
  const images = await api.listOperatingSystems();
  const os = pickOperatingSystem(images, input.os ?? "Ubuntu 24.04");
  const installWeb = input.installWeb !== false;
  const sshKeyIds = await sshKeyIdsFor(api, domain, input);

  let firewallGroupId: string | undefined;
  let firewall: HostDomainResult["firewall"];
  if (input.openFirewall !== false) {
    const ensured = await ensureWebFirewall(api, account, domain);
    firewallGroupId = ensured.id || undefined;
    firewall = ensured;
  }

  const created = await api.createInstance({
    region,
    plan: plan.id,
    os_id: os.id,
    label: instanceLabel(domain),
    hostname: domain,
    enable_ipv6: true,
    tags: [MANAGED_TAG, domain],
    backups: "disabled",
    activation_email: false,
    ...(sshKeyIds.length > 0 ? { sshkey_id: sshKeyIds } : {}),
    ...(installWeb ? { user_data: placeholderUserData(domain) } : {}),
    ...(firewallGroupId ? { firewall_group_id: firewallGroupId } : {}),
  });

  const ready = isReadyIpv4(created.main_ip)
    ? created
    : await waitForPublicIpv4(api, created.id, options, input.waitForIpMs);
  const withPassword = created.default_password
    ? { ...ready, default_password: created.default_password }
    : ready;

  if (firewall?.id) {
    firewall = {
      ...firewall,
      attached: true,
      note: "Attached a firewall that allows SSH (22), HTTP (80), and HTTPS (443) from the internet.",
    };
  }

  return {
    ipv4: assertIpv4(ready.main_ip),
    instance: withPassword,
    summary: {
      ...summarizeHostedInstance(withPassword, false),
      monthly_cost: plan.monthly_cost,
      ...(created.default_password ? { default_password: created.default_password } : {}),
    },
    ...(firewall ? { firewall } : {}),
    webServer: installWeb
      ? "Installed nginx with a placeholder page on the new server. It will be ready after cloud-init finishes, usually a couple of minutes after the instance is active."
      : "Not installed. The new server was created without a web server.",
    billingNote: `Created plan ${plan.id} in ${region} at about $${plan.monthly_cost}/month. Backups are off. Vultr bills this server until you delete it, including while it is halted.`,
  };
}

async function ensureZone(
  api: VultrApi,
  domain: string,
  dnsSec: boolean,
): Promise<{ created: boolean; dnsSec: string }> {
  try {
    const existing = await api.getDomain(domain);
    if (dnsSec && existing.dns_sec !== "enabled") {
      const updated = await api.updateDomain(domain, { dns_sec: "enabled" });
      return { created: false, dnsSec: updated.dns_sec };
    }
    return { created: false, dnsSec: existing.dns_sec };
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const created = await api.createDomain({
    domain,
    ...(dnsSec ? { dns_sec: "enabled" as const } : {}),
  });
  return { created: true, dnsSec: created.dns_sec };
}

async function upsertRecord(api: VultrApi, domain: string, record: RecordWrite): Promise<RecordChange> {
  const relative = relativeRecordName(domain, record.name);
  const existing = (await api.listRecords(domain)).filter(
    (item) => item.type === record.type && sameRecordName(domain, item.name, relative),
  );
  const payload: RecordWrite = { ...record, name: relative };
  const exact = existing.find((item) => sameRecordData(item, record));
  if (exact) {
    return toChange(exact, "unchanged", existing);
  }
  const current = existing[0];
  if (!current) {
    const created = await api.createRecord(domain, payload);
    return toChange(created, "created", []);
  }
  const updated = await api.updateRecord(domain, current.id, {
    name: relative,
    data: record.data,
    ttl: record.ttl,
    ...(record.priority === undefined ? {} : { priority: record.priority }),
  });
  return {
    ...toChange(updated, "updated", existing),
    previous_data: current.data,
  };
}

function sameRecordData(item: DnsRecord, record: RecordWrite): boolean {
  if (item.data !== record.data) return false;
  if (record.ttl !== undefined && item.ttl !== record.ttl) return false;
  if (record.priority !== undefined && item.priority !== record.priority) return false;
  return true;
}

function toChange(
  record: DnsRecord,
  action: RecordChange["action"],
  siblings: readonly DnsRecord[],
): RecordChange {
  const duplicateIds = siblings.map((item) => item.id).filter((id) => id !== record.id);
  return {
    id: record.id,
    name: displayRecordName(record.name),
    type: record.type,
    data: record.data,
    action,
    ...(duplicateIds.length > 0 ? { duplicate_ids: duplicateIds } : {}),
  };
}

async function findManagedInstance(api: VultrApi, domain: string): Promise<Instance | undefined> {
  const instances = await api.listInstances();
  const matches = instances.filter((instance) => instanceHostsDomain(instance, domain));
  const ready = matches.find((instance) => isReadyIpv4(instance.main_ip));
  return ready ?? matches[0];
}

export function instanceLabel(domain: string): string {
  return `host-${domain}`.slice(0, 255);
}

export function instanceHostsDomain(instance: Instance, domain: string): boolean {
  const tags = instance.tags ?? [];
  return instance.label === instanceLabel(domain) || (tags.includes(MANAGED_TAG) && tags.includes(domain));
}

async function sshKeyIdsFor(api: VultrApi, domain: string, input: HostDomainInput): Promise<string[]> {
  const ids: string[] = [];
  if (input.sshKeyId) ids.push(input.sshKeyId);
  if (input.sshPublicKey) ids.push(await ensureSshKey(api, domain, input.sshPublicKey));
  return [...new Set(ids)];
}

async function ensureSshKey(api: VultrApi, domain: string, publicKey: string): Promise<string> {
  const trimmed = publicKey.trim();
  if (!OPENSSH_KEY.test(trimmed)) {
    throw new Error('ssh_public_key must be an OpenSSH public key, such as "ssh-ed25519 AAAA... comment".');
  }
  const fingerprint = trimmed.split(/\s+/).slice(0, 2).join(" ");
  const keys = await api.listSshKeys();
  const existing = keys.find((key) => keyMaterial(key) === fingerprint);
  if (existing) return existing.id;
  const created = await api.createSshKey({
    name: `host-${domain}`.slice(0, 64),
    ssh_key: trimmed,
  });
  return created.id;
}

function keyMaterial(key: SshKey): string {
  return key.ssh_key.trim().split(/\s+/).slice(0, 2).join(" ");
}

async function attachWebFirewall(
  api: VultrApi,
  domain: string,
  instance: Instance,
  enabled: boolean,
): Promise<{ firewall?: HostDomainResult["firewall"] }> {
  if (!enabled) return {};
  if (instance.firewall_group_id) {
    return {
      firewall: {
        id: instance.firewall_group_id,
        attached: true,
        note: `Left the instance's existing firewall group ${instance.firewall_group_id} in place.`,
      },
    };
  }
  const account = await api.getAccount();
  const ensured = await ensureWebFirewall(api, account, domain);
  if (!ensured.id) return { firewall: ensured };
  await api.updateInstance(instance.id, { firewall_group_id: ensured.id });
  return {
    firewall: {
      id: ensured.id,
      attached: true,
      note: "Attached a firewall that allows SSH (22), HTTP (80), and HTTPS (443) from the internet.",
    },
  };
}

async function ensureWebFirewall(
  api: VultrApi,
  account: Account,
  domain: string,
): Promise<NonNullable<HostDomainResult["firewall"]>> {
  if (requireKnownAcl(account, "firewall") === false) {
    return {
      id: "",
      attached: false,
      note: "This API key cannot manage firewalls. The server was left on Vultr's default networking.",
    };
  }

  const description = `Web ports for ${domain}`;
  try {
    const groups = await api.listFirewallGroups();
    let group = groups.find((item) => item.description === description);
    if (!group) group = await api.createFirewallGroup(description);
    await ensureRules(api, group);
    return {
      id: group.id,
      attached: false,
      note: "Prepared a firewall that allows SSH (22), HTTP (80), and HTTPS (443).",
    };
  } catch (error) {
    if (isForbidden(error)) {
      return {
        id: "",
        attached: false,
        note: `Could not manage firewalls (${error instanceof Error ? error.message : String(error)}). The server uses Vultr's default networking.`,
      };
    }
    throw error;
  }
}

async function ensureRules(api: VultrApi, group: FirewallGroup): Promise<void> {
  const rules = await api.listFirewallRules(group.id);
  for (const wanted of WEB_RULES) {
    const present = rules.some(
      (rule) =>
        rule.ip_type === wanted.ip_type &&
        rule.protocol.toLowerCase() === wanted.protocol &&
        samePort(rule.port, wanted.port) &&
        rule.subnet === wanted.subnet &&
        rule.subnet_size === wanted.subnet_size,
    );
    if (!present) await api.createFirewallRule(group.id, wanted);
  }
}

function samePort(actual: string | number | undefined, expected: string | undefined): boolean {
  const left = actual === undefined ? "" : String(actual);
  const right = expected ?? "";
  if (right === "") return left === "" || left === "0";
  return left === right;
}

function summarizeHostedInstance(instance: Instance, reused: boolean): NonNullable<HostDomainResult["instance"]> {
  return {
    id: instance.id,
    region: instance.region,
    plan: instance.plan,
    os: instance.os,
    main_ip: instance.main_ip,
    v6_main_ip: instance.v6_main_ip,
    status: instance.status,
    label: instance.label,
    hostname: instance.hostname,
    reused,
  };
}

function isReadyIpv4(ip: string | undefined): boolean {
  return Boolean(ip) && ip !== "0.0.0.0";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && (error as { status: unknown }).status === 404;
}

function isForbidden(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    ((error as { status: unknown }).status === 401 || (error as { status: unknown }).status === 403)
  );
}

function requireKnownAcl(account: Account, acl: string): boolean | "unknown" {
  if (!Array.isArray(account.acls)) return "unknown";
  return account.acls.includes(acl);
}
