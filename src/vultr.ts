import { SERVER_VERSION } from "./version.js";

export class VultrError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details: unknown) {
    super(`Vultr API ${status}: ${message}`);
    this.name = "VultrError";
    this.status = status;
    this.details = details;
  }
}

export interface Account {
  name: string;
  email: string;
  acls?: string[];
  balance: number;
  pending_charges: number;
  last_payment_date?: string;
  last_payment_amount?: number;
}

export interface DnsDomain {
  domain: string;
  date_created: string;
  dns_sec: string;
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  data: string;
  priority: number;
  ttl: number;
}

export interface Region {
  id: string;
  city: string;
  country: string;
  continent: string;
}

export interface Plan {
  id: string;
  vcpu_count: number;
  ram: number;
  disk: number;
  bandwidth: number;
  monthly_cost: number;
  type: string;
  locations: string[];
}

export interface OsImage {
  id: number;
  name: string;
  arch: string;
  family: string;
}

export interface Instance {
  id: string;
  os: string;
  ram: number;
  disk: number;
  main_ip: string;
  vcpu_count: number;
  region: string;
  plan: string;
  status: string;
  power_status: string;
  label: string;
  hostname: string;
  os_id: number;
  v6_main_ip: string;
  firewall_group_id: string;
  tags: string[];
  default_password?: string;
}

export interface SshKey {
  id: string;
  name: string;
  ssh_key: string;
  date_created?: string;
}

export interface FirewallGroup {
  id: string;
  description: string;
  date_created?: string;
  instance_count?: number;
  rule_count?: number;
}

export interface FirewallRule {
  id?: number;
  ip_type: string;
  protocol: string;
  port?: string;
  subnet: string;
  subnet_size: number;
  notes?: string;
}

export interface RecordWrite {
  name: string;
  type: string;
  data: string;
  ttl?: number;
  priority?: number;
}

export interface CreateInstanceInput {
  region: string;
  plan: string;
  os_id: number;
  label: string;
  hostname: string;
  enable_ipv6: boolean;
  tags: string[];
  backups: "disabled" | "enabled";
  activation_email: boolean;
  sshkey_id?: string[];
  user_data?: string;
  firewall_group_id?: string;
}

export interface VultrApi {
  redact(text: string): string;
  getAccount(): Promise<Account>;
  listDomains(): Promise<DnsDomain[]>;
  getDomain(domain: string): Promise<DnsDomain>;
  createDomain(input: { domain: string; ip?: string; dns_sec?: "enabled" | "disabled" }): Promise<DnsDomain>;
  updateDomain(domain: string, input: { dns_sec: "enabled" | "disabled" }): Promise<DnsDomain>;
  deleteDomain(domain: string): Promise<void>;
  listRecords(domain: string): Promise<DnsRecord[]>;
  getRecord(domain: string, recordId: string): Promise<DnsRecord>;
  createRecord(domain: string, input: RecordWrite): Promise<DnsRecord>;
  updateRecord(domain: string, recordId: string, input: Partial<RecordWrite>): Promise<DnsRecord>;
  deleteRecord(domain: string, recordId: string): Promise<void>;
  getDnssec(domain: string): Promise<string[]>;
  listRegions(): Promise<Region[]>;
  listPlans(type?: string): Promise<Plan[]>;
  listOperatingSystems(): Promise<OsImage[]>;
  listInstances(): Promise<Instance[]>;
  getInstance(instanceId: string): Promise<Instance>;
  createInstance(input: CreateInstanceInput): Promise<Instance>;
  updateInstance(
    instanceId: string,
    input: { firewall_group_id?: string; label?: string; tags?: string[] },
  ): Promise<Instance>;
  deleteInstance(instanceId: string): Promise<void>;
  startInstance(instanceId: string): Promise<void>;
  haltInstance(instanceId: string): Promise<void>;
  rebootInstance(instanceId: string): Promise<void>;
  listSshKeys(): Promise<SshKey[]>;
  createSshKey(input: { name: string; ssh_key: string }): Promise<SshKey>;
  listFirewallGroups(): Promise<FirewallGroup[]>;
  createFirewallGroup(description: string): Promise<FirewallGroup>;
  listFirewallRules(groupId: string): Promise<FirewallRule[]>;
  createFirewallRule(groupId: string, input: FirewallRule): Promise<void>;
}

type Query = Record<string, string | number | boolean | undefined>;

const DEFAULT_BASE_URL = "https://api.vultr.com/v2";

export class VultrClient implements VultrApi {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { apiKey: string; baseUrl?: string; fetch?: typeof fetch }) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) throw new Error("VULTR_API_KEY is empty.");
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  redact(text: string): string {
    return text.split(this.apiKey).join("[redacted]");
  }

  async getAccount(): Promise<Account> {
    return this.unwrap<Account>("GET", "/account", "account");
  }

  listDomains(): Promise<DnsDomain[]> {
    return this.collect<DnsDomain>("/domains", "domains");
  }

  getDomain(domain: string): Promise<DnsDomain> {
    return this.unwrap<DnsDomain>("GET", `/domains/${encodeURIComponent(domain)}`, "domain");
  }

  createDomain(input: { domain: string; ip?: string; dns_sec?: "enabled" | "disabled" }): Promise<DnsDomain> {
    return this.unwrap<DnsDomain>("POST", "/domains", "domain", definedBody(input));
  }

  async updateDomain(domain: string, input: { dns_sec: "enabled" | "disabled" }): Promise<DnsDomain> {
    const body = await this.send<{ domain?: DnsDomain }>(
      "PUT",
      `/domains/${encodeURIComponent(domain)}`,
      input,
    );
    return body.domain ?? this.getDomain(domain);
  }

  async deleteDomain(domain: string): Promise<void> {
    await this.send("DELETE", `/domains/${encodeURIComponent(domain)}`);
  }

  listRecords(domain: string): Promise<DnsRecord[]> {
    return this.collect<DnsRecord>(`/domains/${encodeURIComponent(domain)}/records`, "records");
  }

  getRecord(domain: string, recordId: string): Promise<DnsRecord> {
    return this.unwrap<DnsRecord>(
      "GET",
      `/domains/${encodeURIComponent(domain)}/records/${encodeURIComponent(recordId)}`,
      "record",
    );
  }

  createRecord(domain: string, input: RecordWrite): Promise<DnsRecord> {
    return this.unwrap<DnsRecord>(
      "POST",
      `/domains/${encodeURIComponent(domain)}/records`,
      "record",
      definedBody(input),
    );
  }

  async updateRecord(domain: string, recordId: string, input: Partial<RecordWrite>): Promise<DnsRecord> {
    const body = await this.send<{ record?: DnsRecord }>(
      "PATCH",
      `/domains/${encodeURIComponent(domain)}/records/${encodeURIComponent(recordId)}`,
      definedBody(input),
    );
    return body.record ?? this.getRecord(domain, recordId);
  }

  async deleteRecord(domain: string, recordId: string): Promise<void> {
    await this.send(
      "DELETE",
      `/domains/${encodeURIComponent(domain)}/records/${encodeURIComponent(recordId)}`,
    );
  }

  async getDnssec(domain: string): Promise<string[]> {
    const body = await this.send<{ dns_sec?: string[] }>(
      "GET",
      `/domains/${encodeURIComponent(domain)}/dnssec`,
    );
    return body.dns_sec ?? [];
  }

  listRegions(): Promise<Region[]> {
    return this.collect<Region>("/regions", "regions");
  }

  async listPlans(type?: string): Promise<Plan[]> {
    const plans = await this.collect<Plan>("/plans", "plans", { type });
    return plans.map((plan) => ({ ...plan, locations: plan.locations ?? [] }));
  }

  listOperatingSystems(): Promise<OsImage[]> {
    return this.collect<OsImage>("/os", "os");
  }

  async listInstances(): Promise<Instance[]> {
    const instances = await this.collect<Instance>("/instances", "instances");
    return instances.map(normalizeInstance);
  }

  async getInstance(instanceId: string): Promise<Instance> {
    return normalizeInstance(
      await this.unwrap<Instance>("GET", `/instances/${encodeURIComponent(instanceId)}`, "instance"),
    );
  }

  async createInstance(input: CreateInstanceInput): Promise<Instance> {
    return normalizeInstance(await this.unwrap<Instance>("POST", "/instances", "instance", definedBody(input)));
  }

  async updateInstance(
    instanceId: string,
    input: { firewall_group_id?: string; label?: string; tags?: string[] },
  ): Promise<Instance> {
    const body = await this.send<{ instance?: Instance }>(
      "PATCH",
      `/instances/${encodeURIComponent(instanceId)}`,
      definedBody(input),
    );
    return normalizeInstance(body.instance ?? (await this.getInstance(instanceId)));
  }

  async deleteInstance(instanceId: string): Promise<void> {
    await this.send("DELETE", `/instances/${encodeURIComponent(instanceId)}`);
  }

  async startInstance(instanceId: string): Promise<void> {
    await this.send("POST", `/instances/${encodeURIComponent(instanceId)}/start`);
  }

  async haltInstance(instanceId: string): Promise<void> {
    await this.send("POST", `/instances/${encodeURIComponent(instanceId)}/halt`);
  }

  async rebootInstance(instanceId: string): Promise<void> {
    await this.send("POST", `/instances/${encodeURIComponent(instanceId)}/reboot`);
  }

  listSshKeys(): Promise<SshKey[]> {
    return this.collect<SshKey>("/ssh-keys", "ssh_keys");
  }

  createSshKey(input: { name: string; ssh_key: string }): Promise<SshKey> {
    return this.unwrap<SshKey>("POST", "/ssh-keys", "ssh_key", input);
  }

  listFirewallGroups(): Promise<FirewallGroup[]> {
    return this.collect<FirewallGroup>("/firewalls", "firewall_groups");
  }

  createFirewallGroup(description: string): Promise<FirewallGroup> {
    return this.unwrap<FirewallGroup>("POST", "/firewalls", "firewall_group", { description });
  }

  listFirewallRules(groupId: string): Promise<FirewallRule[]> {
    return this.collect<FirewallRule>(`/firewalls/${encodeURIComponent(groupId)}/rules`, "firewall_rules");
  }

  async createFirewallRule(groupId: string, input: FirewallRule): Promise<void> {
    await this.send("POST", `/firewalls/${encodeURIComponent(groupId)}/rules`, definedBody(input));
  }

  private async collect<T>(path: string, key: string, query?: Query): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const body = await this.send<Record<string, unknown>>("GET", path, undefined, {
        ...query,
        per_page: 500,
        cursor,
      });
      const chunk = body[key];
      if (!Array.isArray(chunk)) {
        throw new Error(`Unexpected Vultr response from ${path}: missing "${key}".`);
      }
      items.push(...(chunk as T[]));
      const meta = body["meta"] as { links?: { next?: string } } | undefined;
      const next = meta?.links?.next;
      if (!next) return items;
      cursor = next;
    }
    return items;
  }

  private async unwrap<T>(method: string, path: string, key: string, body?: unknown): Promise<T> {
    const response = await this.send<Record<string, T>>(method, path, body);
    const value = response[key];
    if (value === undefined) {
      throw new Error(`Unexpected Vultr response from ${path}: missing "${key}".`);
    }
    return value;
  }

  private async send<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
      }
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          "User-Agent": `vultr-domain-mcp/${SERVER_VERSION}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new Error(`Timed out calling Vultr ${method} ${path}.`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(this.redact(`Could not reach Vultr: ${message}`));
    }

    const text = await response.text();
    const parsed = text ? parseJson(text) : undefined;
    if (!response.ok) {
      throw new VultrError(response.status, errorDetail(parsed, text, response.status), parsed ?? text);
    }
    return (parsed ?? {}) as T;
  }
}

function definedBody(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function normalizeInstance(instance: Instance): Instance {
  return {
    ...instance,
    tags: instance.tags ?? [],
    v6_main_ip: instance.v6_main_ip ?? "",
    firewall_group_id: instance.firewall_group_id ?? "",
    main_ip: instance.main_ip ?? "",
    label: instance.label ?? "",
    hostname: instance.hostname ?? "",
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorDetail(parsed: unknown, text: string, status: number): string {
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const error = (parsed as { error: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
    if (error !== undefined) return JSON.stringify(error);
  }
  const trimmed = text.trim();
  if (trimmed && trimmed.length < 500 && parsed === undefined) return trimmed;
  return `HTTP ${status}`;
}

export function hasAcl(account: Account, acl: string): boolean | "unknown" {
  if (!Array.isArray(account.acls)) return "unknown";
  return account.acls.includes(acl);
}

export function requireAcl(account: Account, acl: string, message: string): void {
  if (hasAcl(account, acl) === false) throw new Error(message);
}
