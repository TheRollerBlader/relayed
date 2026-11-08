import { VultrError } from "../src/vultr.js";
import type {
  Account,
  CreateInstanceInput,
  DnsDomain,
  DnsRecord,
  FirewallGroup,
  FirewallRule,
  Instance,
  OsImage,
  Plan,
  RecordWrite,
  Region,
  SshKey,
  VultrApi,
} from "../src/vultr.js";

export class FakeVultr implements VultrApi {
  account: Account = {
    name: "Ada",
    email: "ada@example.com",
    acls: ["dns", "provisioning", "firewall"],
    balance: 25,
    pending_charges: 0,
  };

  regions: Region[] = [
    { id: "ewr", city: "New Jersey", country: "US", continent: "North America" },
    { id: "lhr", city: "London", country: "GB", continent: "Europe" },
  ];

  plans: Plan[] = [
    {
      id: "vc2-1c-1gb",
      vcpu_count: 1,
      ram: 1024,
      disk: 25,
      bandwidth: 1000,
      monthly_cost: 5,
      type: "vc2",
      locations: ["ewr", "lhr"],
    },
    {
      id: "vc2-2c-4gb",
      vcpu_count: 2,
      ram: 4096,
      disk: 80,
      bandwidth: 3000,
      monthly_cost: 20,
      type: "vc2",
      locations: ["ewr"],
    },
    {
      id: "vhf-1c-1gb",
      vcpu_count: 1,
      ram: 1024,
      disk: 32,
      bandwidth: 2000,
      monthly_cost: 6,
      type: "vhf",
      locations: ["ewr"],
    },
  ];

  operatingSystems: OsImage[] = [
    { id: 1743, name: "Ubuntu 22.04 LTS x64", arch: "x64", family: "ubuntu" },
    { id: 2284, name: "Ubuntu 24.04 LTS x64", arch: "x64", family: "ubuntu" },
    { id: 215, name: "CentOS 8 Stream x64", arch: "x64", family: "centos" },
  ];

  instances: Instance[] = [];
  createdPayloads: CreateInstanceInput[] = [];
  updates: { id: string; input: { firewall_group_id?: string; label?: string; tags?: string[] } }[] = [];
  powerActions: string[] = [];
  ipDelayGets = 0;

  private domains = new Map<string, DnsDomain>();
  private records = new Map<string, DnsRecord[]>();
  private keys: SshKey[] = [];
  private groups: { group: FirewallGroup; rules: FirewallRule[] }[] = [];
  private sequence = 0;
  private address = 10;
  private gets = new Map<string, number>();

  redact(text: string): string {
    return text.split("secret-token").join("[redacted]");
  }

  async getAccount(): Promise<Account> {
    return structuredClone(this.account);
  }

  async listDomains(): Promise<DnsDomain[]> {
    return [...this.domains.values()].map((domain) => structuredClone(domain));
  }

  async getDomain(domain: string): Promise<DnsDomain> {
    const found = this.domains.get(domain);
    if (!found) throw new VultrError(404, "Not found", { domain });
    return structuredClone(found);
  }

  async createDomain(input: { domain: string; ip?: string; dns_sec?: "enabled" | "disabled" }): Promise<DnsDomain> {
    if (this.domains.has(input.domain)) throw new VultrError(400, "Domain already exists", input);
    const created: DnsDomain = {
      domain: input.domain,
      date_created: "2026-01-01T00:00:00+00:00",
      dns_sec: input.dns_sec ?? "disabled",
    };
    this.domains.set(input.domain, created);
    this.records.set(input.domain, []);
    if (input.ip) {
      await this.createRecord(input.domain, { name: "", type: "A", data: input.ip, ttl: 300 });
    }
    return structuredClone(created);
  }

  async updateDomain(domain: string, input: { dns_sec: "enabled" | "disabled" }): Promise<DnsDomain> {
    const found = await this.getDomain(domain);
    found.dns_sec = input.dns_sec;
    this.domains.set(domain, found);
    return structuredClone(found);
  }

  async deleteDomain(domain: string): Promise<void> {
    if (!this.domains.delete(domain)) throw new VultrError(404, "Not found", { domain });
    this.records.delete(domain);
  }

  async listRecords(domain: string): Promise<DnsRecord[]> {
    await this.getDomain(domain);
    return (this.records.get(domain) ?? []).map((record) => structuredClone(record));
  }

  async getRecord(domain: string, recordId: string): Promise<DnsRecord> {
    const record = (await this.listRecords(domain)).find((item) => item.id === recordId);
    if (!record) throw new VultrError(404, "Record not found", { recordId });
    return record;
  }

  async createRecord(domain: string, input: RecordWrite): Promise<DnsRecord> {
    await this.getDomain(domain);
    const record: DnsRecord = {
      id: `rec-${this.next()}`,
      type: input.type,
      name: input.name,
      data: input.data,
      priority: input.priority ?? 0,
      ttl: input.ttl ?? 300,
    };
    const records = this.records.get(domain) ?? [];
    records.push(record);
    this.records.set(domain, records);
    return structuredClone(record);
  }

  async updateRecord(domain: string, recordId: string, input: Partial<RecordWrite>): Promise<DnsRecord> {
    const records = this.records.get(domain);
    if (!records) throw new VultrError(404, "Not found", { domain });
    const record = records.find((item) => item.id === recordId);
    if (!record) throw new VultrError(404, "Record not found", { recordId });
    if (input.name !== undefined) record.name = input.name;
    if (input.data !== undefined) record.data = input.data;
    if (input.ttl !== undefined) record.ttl = input.ttl;
    if (input.priority !== undefined) record.priority = input.priority;
    if (input.type !== undefined) record.type = input.type;
    return structuredClone(record);
  }

  async deleteRecord(domain: string, recordId: string): Promise<void> {
    const records = this.records.get(domain);
    if (!records) throw new VultrError(404, "Not found", { domain });
    const index = records.findIndex((item) => item.id === recordId);
    if (index < 0) throw new VultrError(404, "Record not found", { recordId });
    records.splice(index, 1);
  }

  async getDnssec(domain: string): Promise<string[]> {
    const zone = await this.getDomain(domain);
    if (zone.dns_sec !== "enabled") return [];
    return [`${domain} IN DS 27933 13 2 8858e7b0dfb881280ce2ca1e0eafcd93d5b53687c21da284d4f8799ba82208a9`];
  }

  async listRegions(): Promise<Region[]> {
    return structuredClone(this.regions);
  }

  async listPlans(type?: string): Promise<Plan[]> {
    const plans = type ? this.plans.filter((plan) => plan.type === type) : this.plans;
    return structuredClone(plans);
  }

  async listOperatingSystems(): Promise<OsImage[]> {
    return structuredClone(this.operatingSystems);
  }

  async listInstances(): Promise<Instance[]> {
    return this.instances.map((instance) => structuredClone(instance));
  }

  async getInstance(instanceId: string): Promise<Instance> {
    const instance = this.instances.find((item) => item.id === instanceId);
    if (!instance) throw new VultrError(404, "Instance not found", { instanceId });
    const seen = (this.gets.get(instanceId) ?? 0) + 1;
    this.gets.set(instanceId, seen);
    if (instance.main_ip === "0.0.0.0" && seen > this.ipDelayGets) {
      instance.main_ip = this.nextAddress();
    }
    return structuredClone(instance);
  }

  async createInstance(input: CreateInstanceInput): Promise<Instance> {
    this.createdPayloads.push(structuredClone(input));
    const os = this.operatingSystems.find((image) => image.id === input.os_id);
    const instance: Instance = {
      id: `inst-${this.next()}`,
      os: os?.name ?? "Unknown",
      ram: 1024,
      disk: 25,
      main_ip: "0.0.0.0",
      vcpu_count: 1,
      region: input.region,
      plan: input.plan,
      status: "pending",
      power_status: "running",
      label: input.label,
      hostname: input.hostname,
      os_id: input.os_id,
      v6_main_ip: input.enable_ipv6 ? "2001:db8::10" : "",
      firewall_group_id: input.firewall_group_id ?? "",
      tags: [...input.tags],
      default_password: "temporary-root-password",
    };
    if (this.ipDelayGets === 0) {
      instance.main_ip = this.nextAddress();
      instance.status = "active";
    }
    this.instances.push(instance);
    return structuredClone(instance);
  }

  async updateInstance(
    instanceId: string,
    input: { firewall_group_id?: string; label?: string; tags?: string[] },
  ): Promise<Instance> {
    this.updates.push({ id: instanceId, input: structuredClone(input) });
    const instance = this.instances.find((item) => item.id === instanceId);
    if (!instance) throw new VultrError(404, "Instance not found", { instanceId });
    if (input.firewall_group_id !== undefined) instance.firewall_group_id = input.firewall_group_id;
    if (input.label !== undefined) instance.label = input.label;
    if (input.tags !== undefined) instance.tags = [...input.tags];
    return structuredClone(instance);
  }

  async deleteInstance(instanceId: string): Promise<void> {
    const index = this.instances.findIndex((item) => item.id === instanceId);
    if (index < 0) throw new VultrError(404, "Instance not found", { instanceId });
    this.instances.splice(index, 1);
  }

  async startInstance(instanceId: string): Promise<void> {
    await this.getInstance(instanceId);
    this.powerActions.push(`start:${instanceId}`);
  }

  async haltInstance(instanceId: string): Promise<void> {
    await this.getInstance(instanceId);
    this.powerActions.push(`halt:${instanceId}`);
  }

  async rebootInstance(instanceId: string): Promise<void> {
    await this.getInstance(instanceId);
    this.powerActions.push(`reboot:${instanceId}`);
  }

  async listSshKeys(): Promise<SshKey[]> {
    return this.keys.map((key) => structuredClone(key));
  }

  async createSshKey(input: { name: string; ssh_key: string }): Promise<SshKey> {
    const key: SshKey = { id: `ssh-${this.next()}`, name: input.name, ssh_key: input.ssh_key };
    this.keys.push(key);
    return structuredClone(key);
  }

  async listFirewallGroups(): Promise<FirewallGroup[]> {
    return this.groups.map((entry) => structuredClone(entry.group));
  }

  async createFirewallGroup(description: string): Promise<FirewallGroup> {
    const group: FirewallGroup = { id: `fw-${this.next()}`, description, rule_count: 0 };
    this.groups.push({ group, rules: [] });
    return structuredClone(group);
  }

  async listFirewallRules(groupId: string): Promise<FirewallRule[]> {
    const found = this.groups.find((entry) => entry.group.id === groupId);
    if (!found) throw new VultrError(404, "Firewall not found", { groupId });
    return found.rules.map((rule) => structuredClone(rule));
  }

  async createFirewallRule(groupId: string, input: FirewallRule): Promise<void> {
    const found = this.groups.find((entry) => entry.group.id === groupId);
    if (!found) throw new VultrError(404, "Firewall not found", { groupId });
    found.rules.push(structuredClone(input));
    found.group.rule_count = found.rules.length;
  }

  seedInstance(instance: Partial<Instance> & Pick<Instance, "id">): Instance {
    const stored: Instance = {
      os: "Ubuntu 24.04 LTS x64",
      ram: 1024,
      disk: 25,
      main_ip: "203.0.113.20",
      vcpu_count: 1,
      region: "ewr",
      plan: "vc2-1c-1gb",
      status: "active",
      power_status: "running",
      label: instance.label ?? "",
      hostname: "server",
      os_id: 2284,
      v6_main_ip: "",
      firewall_group_id: "",
      tags: [],
      ...instance,
    };
    this.instances.push(stored);
    return structuredClone(stored);
  }

  private next(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private nextAddress(): string {
    this.address += 1;
    return `203.0.113.${this.address}`;
  }
}
