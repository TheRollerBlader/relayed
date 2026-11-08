import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { assertIpv4, assertIpv6, normalizeDomain, relativeRecordName } from "./domain.js";
import { hostDomain, VULTR_NAMESERVERS } from "./host.js";
import { SERVER_VERSION } from "./version.js";
import {
  hasAcl,
  requireAcl,
  type Instance,
  type RecordWrite,
  type VultrApi,
} from "./vultr.js";

const RECORD_TYPES = ["A", "AAAA", "CNAME", "NS", "MX", "SRV", "TXT", "CAA", "SSHFP"] as const;

const GUIDE = `Vultr can host DNS for a domain you already own, and it can run the server that answers HTTP for that domain. Vultr does not register or sell domain names.

1. Call check-account. DNS permission is required. Creating a server also needs provisioning permission.
2. Call host-domain with exactly one target:
   - ip: an address you already have
   - instance_id: an existing Vultr server
   - provision true and acknowledge_billing true: create the cheapest Cloud Compute server
3. At the registrar where the domain was bought, set the nameservers to ${VULTR_NAMESERVERS[0]} and ${VULTR_NAMESERVERS[1]}.
4. Wait for DNS. The placeholder page, if a new server was created, is HTTP only until a certificate is installed on that server.

Re-running host-domain updates A/AAAA records and reuses a server tagged by this MCP server. It does not buy a second server and it does not delete MX records. Halted instances are still billed. delete-instance stops the server charges. delete-domain removes only the Vultr DNS zone.`;

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const openWorld = { openWorldHint: true } as const;

export function createServer(api: VultrApi): McpServer {
  const server = new McpServer({
    name: "vultr-domains",
    version: SERVER_VERSION,
    title: "Vultr domain hosting",
    description:
      "Point a domain you already own at Vultr DNS and, if you want, a Vultr cloud server. Vultr does not register domain names.",
  });

  const tool = <S extends z.ZodType>(
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema: S;
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      };
    },
    handler: (args: z.infer<S>) => Promise<unknown>,
  ): void => {
    // The SDK overloads cannot see through this generic wrapper, so the call is typed locally.
    const register = server.registerTool.bind(server) as (
      toolName: string,
      toolConfig: typeof config,
      callback: (args: z.infer<S>) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>,
    ) => void;
    register(name, config, async (args) => {
      try {
        const value = await handler(args);
        return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: api.redact(message) }] };
      }
    });
  };

  server.registerResource(
    "domain-hosting-guide",
    "vultr://domain-hosting",
    {
      title: "How to host a domain on Vultr",
      description: "Nameservers, billing, and the difference between DNS hosting and registering a domain.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: GUIDE }],
    }),
  );

  server.registerPrompt(
    "host-a-domain",
    {
      title: "Host a domain on Vultr",
      description: "Point a domain you already own at Vultr, optionally creating a server after the user confirms the price.",
      argsSchema: z.object({
        domain: z.string().describe("Domain to host, such as example.com"),
        region: z.string().optional().describe("Optional Vultr region id, such as ewr"),
      }),
    },
    ({ domain, region }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Host ${domain} on Vultr${region ? ` in region ${region}` : ""}. Vultr does not register domains. Use check-account first. If I only want DNS, ask me for the IPv4 address and call host-domain with ip. If I want a new server, tell me the cheapest plan's monthly price and wait for my confirmation before calling host-domain with provision true and acknowledge_billing true. Then tell me to set the nameservers to ${VULTR_NAMESERVERS[0]} and ${VULTR_NAMESERVERS[1]} at my registrar.`,
          },
        },
      ],
    }),
  );

  tool(
    "check-account",
    {
      title: "Check Vultr account",
      description: "Verify the API key and whether it can manage DNS, create servers, and edit firewalls.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    async () => {
      const account = await api.getAccount();
      return {
        name: account.name,
        email: account.email,
        balance: account.balance,
        pending_charges: account.pending_charges,
        permissions: {
          dns: hasAcl(account, "dns"),
          provisioning: hasAcl(account, "provisioning"),
          firewall: hasAcl(account, "firewall"),
        },
      };
    },
  );

  tool(
    "list-domains",
    {
      title: "List DNS domains",
      description: "List DNS zones hosted on this Vultr account.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    async () => api.listDomains(),
  );

  tool(
    "get-domain",
    {
      title: "Get DNS domain",
      description: "Get one Vultr DNS zone, including whether DNSSEC is enabled.",
      inputSchema: z.object({
        domain: z.string().describe("Domain name, such as example.com"),
      }),
      annotations: readOnly,
    },
    async ({ domain }) => api.getDomain(normalizeDomain(domain)),
  );

  tool(
    "create-domain",
    {
      title: "Create DNS domain",
      description:
        "Create an empty Vultr DNS zone for a domain you already own. This does not register the domain. Prefer host-domain when you also want address records.",
      inputSchema: z.object({
        domain: z.string().describe("Domain name you already own, such as example.com"),
        ip: z.string().optional().describe("Optional IPv4. When set, Vultr adds an apex A record."),
        dns_sec: z.boolean().optional().describe("Enable DNSSEC. Defaults to false."),
      }),
      annotations: { ...openWorld, idempotentHint: false },
    },
    async ({ domain, ip, dns_sec: dnsSec }) =>
      api.createDomain({
        domain: normalizeDomain(domain),
        ...(ip ? { ip: assertIpv4(ip) } : {}),
        ...(dnsSec ? { dns_sec: "enabled" as const } : {}),
      }),
  );

  tool(
    "delete-domain",
    {
      title: "Delete DNS domain",
      description:
        "Delete the Vultr DNS zone. This does not cancel the domain registration and does not delete any server. Requires confirm true.",
      inputSchema: z.object({
        domain: z.string().describe("Zone to delete, such as example.com"),
        confirm: z.literal(true).describe("Must be true. This permanently deletes the DNS zone at Vultr."),
      }),
      annotations: { ...openWorld, destructiveHint: true, idempotentHint: true },
    },
    async ({ domain }) => {
      const name = normalizeDomain(domain);
      await api.deleteDomain(name);
      return { deleted: name, note: "The registrar registration, if any, was not cancelled." };
    },
  );

  tool(
    "list-records",
    {
      title: "List DNS records",
      description: "List records in a Vultr DNS zone. Names are relative to the zone; an empty name is the apex.",
      inputSchema: z.object({
        domain: z.string().describe("Zone name, such as example.com"),
      }),
      annotations: readOnly,
    },
    async ({ domain }) => api.listRecords(normalizeDomain(domain)),
  );

  tool(
    "create-record",
    {
      title: "Create DNS record",
      description:
        "Create one DNS record. name is relative to the zone: @ or an empty name is the apex, and www means www.example.com. MX and SRV require priority.",
      inputSchema: z.object({
        domain: z.string().describe("Zone name, such as example.com"),
        name: z.string().describe("Relative hostname. Use @ for the apex."),
        type: z.enum(RECORD_TYPES),
        data: z.string().describe("Record value, such as an IP address, hostname, or TXT string."),
        ttl: z.number().int().min(60).max(86400).optional().describe("Seconds. Defaults to 300."),
        priority: z.number().int().min(0).max(65535).optional().describe("Required for MX and SRV."),
      }),
      annotations: { ...openWorld, idempotentHint: false },
    },
    async ({ domain, name, type, data, ttl, priority }) => {
      const zone = normalizeDomain(domain);
      const record = normalizeRecordWrite({ name, type, data, ttl, priority }, zone);
      return api.createRecord(zone, record);
    },
  );

  tool(
    "update-record",
    {
      title: "Update DNS record",
      description: "Change a DNS record's name, data, TTL, or priority. The record type cannot be changed.",
      inputSchema: z
        .object({
          domain: z.string().describe("Zone name, such as example.com"),
          record_id: z.string().describe("Record id from list-records"),
          name: z.string().optional().describe("New relative hostname. Use @ for the apex."),
          data: z.string().optional().describe("New record value"),
          ttl: z.number().int().min(60).max(86400).optional(),
          priority: z.number().int().min(0).max(65535).optional(),
        })
        .refine((value) => value.name !== undefined || value.data !== undefined || value.ttl !== undefined || value.priority !== undefined, {
          message: "Provide name, data, ttl, or priority to change.",
        }),
      annotations: { ...openWorld, idempotentHint: true },
    },
    async ({ domain, record_id: recordId, name, data, ttl, priority }) => {
      const zone = normalizeDomain(domain);
      return api.updateRecord(zone, recordId, {
        ...(name === undefined ? {} : { name: relativeRecordName(zone, name) }),
        ...(data === undefined ? {} : { data }),
        ...(ttl === undefined ? {} : { ttl }),
        ...(priority === undefined ? {} : { priority }),
      });
    },
  );

  tool(
    "delete-record",
    {
      title: "Delete DNS record",
      description: "Delete one DNS record. Requires confirm true.",
      inputSchema: z.object({
        domain: z.string().describe("Zone name, such as example.com"),
        record_id: z.string().describe("Record id from list-records"),
        confirm: z.literal(true).describe("Must be true."),
      }),
      annotations: { ...openWorld, destructiveHint: true, idempotentHint: true },
    },
    async ({ domain, record_id: recordId }) => {
      const zone = normalizeDomain(domain);
      await api.deleteRecord(zone, recordId);
      return { deleted: recordId, domain: zone };
    },
  );

  tool(
    "get-dnssec",
    {
      title: "Get DNSSEC records",
      description: "Get the DS and DNSKEY records to copy to your registrar after DNSSEC is enabled.",
      inputSchema: z.object({
        domain: z.string().describe("Zone name, such as example.com"),
      }),
      annotations: readOnly,
    },
    async ({ domain }) => {
      const zone = normalizeDomain(domain);
      return { domain: zone, records: await api.getDnssec(zone) };
    },
  );

  tool(
    "set-dnssec",
    {
      title: "Enable or disable DNSSEC",
      description:
        "Turn DNSSEC on or off for a Vultr zone. After enabling, call get-dnssec and add the DS records at the registrar.",
      inputSchema: z.object({
        domain: z.string().describe("Zone name, such as example.com"),
        enabled: z.boolean().describe("True enables DNSSEC. False disables it."),
      }),
      annotations: { ...openWorld, idempotentHint: true },
    },
    async ({ domain, enabled }) => {
      const zone = normalizeDomain(domain);
      const updated = await api.updateDomain(zone, { dns_sec: enabled ? "enabled" : "disabled" });
      const records = enabled ? await api.getDnssec(zone) : [];
      return { domain: updated, ds_records: records };
    },
  );

  tool(
    "host-domain",
    {
      title: "Host a domain on Vultr",
      description:
        "Publish a Vultr DNS zone for a domain you already own and point it at an IPv4 address, an existing instance, or a new cloud server. Vultr does not register domains. Pass exactly one of ip, instance_id, or provision. provision creates a billable server and requires acknowledge_billing true. Re-running reuses a server this tool already created for the domain and does not remove MX or other unrelated records. Afterward, set the registrar nameservers to ns1.vultr.com and ns2.vultr.com.",
      inputSchema: z
        .object({
          domain: z.string().describe("Domain you already own, such as example.com. No https:// and no path."),
          ip: z
            .string()
            .optional()
            .describe("Existing IPv4 to publish. Mutually exclusive with instance_id and provision."),
          ipv6: z.string().optional().describe("Optional IPv6. Creates AAAA records. An instance's IPv6 is used when this is omitted."),
          instance_id: z.string().optional().describe("Existing Vultr instance to point the domain at."),
          provision: z
            .boolean()
            .optional()
            .describe("Create a new billable Vultr server when true. Reuses a server this tool already created for the same domain."),
          acknowledge_billing: z
            .boolean()
            .optional()
            .describe("Must be true when provision is true. The server is billed until it is deleted."),
          region: z.string().optional().describe("Region id, such as ewr, lhr, or ams. Defaults to ewr. Ignored when reusing a server."),
          plan: z.string().optional().describe("Plan id, such as vc2-1c-1gb. Defaults to the cheapest Cloud Compute plan in the region."),
          os: z.string().optional().describe("Operating system name to search for. Defaults to Ubuntu 24.04."),
          ssh_key_id: z.string().optional().describe("Existing SSH key id to install on a new server."),
          ssh_public_key: z
            .string()
            .optional()
            .describe("OpenSSH public key to install on a new server. It is saved to the Vultr account if missing."),
          www: z.boolean().optional().describe("Also point www at the same address. Defaults to true."),
          ttl: z.number().int().min(60).max(86400).optional().describe("DNS TTL in seconds. Defaults to 300."),
          dns_sec: z.boolean().optional().describe("Enable DNSSEC. You must add the returned DS records at the registrar."),
          open_firewall: z
            .boolean()
            .optional()
            .describe("Allow SSH, HTTP, and HTTPS when the instance has no firewall yet. Defaults to true. An existing firewall is not replaced."),
          install_web: z
            .boolean()
            .optional()
            .describe("On a newly created server, install nginx and a placeholder page. Defaults to true. Never reinstalls an existing server."),
        })
        .refine((value) => Number(Boolean(value.ip)) + Number(Boolean(value.instance_id)) + Number(Boolean(value.provision)) === 1, {
          message: "Provide exactly one of ip, instance_id, or provision: true.",
        })
        .refine((value) => value.provision !== true || value.acknowledge_billing === true, {
          message: "provision creates a billable Vultr instance. Set acknowledge_billing to true to confirm the monthly charge.",
        }),
      annotations: { ...openWorld, destructiveHint: false, idempotentHint: true },
    },
    async (args) =>
      hostDomain(api, {
        domain: args.domain,
        ...(args.ip ? { ip: args.ip } : {}),
        ...(args.ipv6 ? { ipv6: args.ipv6 } : {}),
        ...(args.instance_id ? { instanceId: args.instance_id } : {}),
        ...(args.provision ? { provision: args.provision } : {}),
        ...(args.region ? { region: args.region } : {}),
        ...(args.plan ? { plan: args.plan } : {}),
        ...(args.os ? { os: args.os } : {}),
        ...(args.ssh_key_id ? { sshKeyId: args.ssh_key_id } : {}),
        ...(args.ssh_public_key ? { sshPublicKey: args.ssh_public_key } : {}),
        ...(args.www === undefined ? {} : { www: args.www }),
        ...(args.ttl === undefined ? {} : { ttl: args.ttl }),
        ...(args.dns_sec ? { dnsSec: true } : {}),
        ...(args.open_firewall === undefined ? {} : { openFirewall: args.open_firewall }),
        ...(args.install_web === undefined ? {} : { installWeb: args.install_web }),
      }),
  );

  tool(
    "list-regions",
    {
      title: "List Vultr regions",
      description: "List region ids you can pass to host-domain, such as ewr or lhr.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    async () => api.listRegions(),
  );

  tool(
    "list-plans",
    {
      title: "List Vultr plans",
      description: "List server plans and monthly prices. Defaults to Cloud Compute (vc2), cheapest first. Pass type all to include every plan type.",
      inputSchema: z.object({
        region: z.string().optional().describe("Only plans offered in this region id."),
        type: z.string().optional().describe("Plan type such as vc2, vhf, or all. Defaults to vc2."),
      }),
      annotations: readOnly,
    },
    async ({ region, type }) => {
      const requested = (type ?? "vc2").trim().toLowerCase();
      const plans = await api.listPlans(requested === "all" ? undefined : requested);
      const filtered = region ? plans.filter((plan) => plan.locations.includes(region)) : plans;
      return [...filtered].sort((left, right) => left.monthly_cost - right.monthly_cost || left.id.localeCompare(right.id));
    },
  );

  tool(
    "list-operating-systems",
    {
      title: "List operating systems",
      description: "List OS images. Pass a query such as Ubuntu 24.04 to filter. Do not hardcode os ids from examples; they change.",
      inputSchema: z.object({
        query: z.string().optional().describe("Case-insensitive name filter."),
      }),
      annotations: readOnly,
    },
    async ({ query }) => {
      const images = await api.listOperatingSystems();
      if (!query) return images;
      const needle = query.toLowerCase();
      return images.filter((image) => image.name.toLowerCase().includes(needle));
    },
  );

  tool(
    "list-instances",
    {
      title: "List instances",
      description: "List Vultr cloud servers. Does not include root passwords.",
      inputSchema: z.object({
        region: z.string().optional().describe("Filter by region id."),
      }),
      annotations: readOnly,
    },
    async ({ region }) => {
      const instances = await api.listInstances();
      const filtered = region ? instances.filter((instance) => instance.region === region) : instances;
      return filtered.map(summarizeInstance);
    },
  );

  tool(
    "get-instance",
    {
      title: "Get instance",
      description: "Get one Vultr cloud server by id. Does not include the original root password.",
      inputSchema: z.object({
        instance_id: z.string().describe("Instance id"),
      }),
      annotations: readOnly,
    },
    async ({ instance_id: instanceId }) => summarizeInstance(await api.getInstance(instanceId)),
  );

  tool(
    "create-instance",
    {
      title: "Create instance",
      description:
        "Create a billable Vultr cloud server. Requires acknowledge_billing true. This does not publish DNS; call host-domain if the goal is to host a domain. The server is billed until it is deleted, even if halted. Backups default to off.",
      inputSchema: z.object({
        region: z.string().describe("Region id, such as ewr"),
        plan: z.string().describe("Plan id from list-plans"),
        os_id: z.number().int().positive().describe("Operating system id from list-operating-systems"),
        label: z.string().min(1).describe("Label shown in the Vultr portal"),
        hostname: z.string().optional().describe("Hostname. Defaults to the label."),
        ssh_key_ids: z.array(z.string()).optional().describe("SSH key ids to install"),
        enable_ipv6: z.boolean().optional().describe("Defaults to true."),
        tags: z.array(z.string()).optional(),
        firewall_group_id: z.string().optional(),
        acknowledge_billing: z.literal(true).describe("Required. This creates a billable instance."),
      }),
      annotations: { ...openWorld, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const account = await api.getAccount();
      requireAcl(
        account,
        "provisioning",
        "This API key cannot create servers (missing the provisioning permission).",
      );
      const instance = await api.createInstance({
        region: args.region,
        plan: args.plan,
        os_id: args.os_id,
        label: args.label,
        hostname: args.hostname ?? args.label,
        enable_ipv6: args.enable_ipv6 !== false,
        tags: args.tags ?? [],
        backups: "disabled",
        activation_email: false,
        ...(args.ssh_key_ids && args.ssh_key_ids.length > 0 ? { sshkey_id: args.ssh_key_ids } : {}),
        ...(args.firewall_group_id ? { firewall_group_id: args.firewall_group_id } : {}),
      });
      return {
        billing_note: `Created plan ${instance.plan} in ${instance.region}. Vultr bills it until you delete it, including while it is halted.`,
        instance: summarizeInstance(instance),
        ...(instance.default_password
          ? {
              default_password: instance.default_password,
              password_note: "This root password is shown only now. Change it after you sign in. This MCP server does not store it.",
            }
          : {}),
      };
    },
  );

  tool(
    "delete-instance",
    {
      title: "Delete instance",
      description:
        "Delete a Vultr cloud server and stop future charges for it. DNS records are not deleted. Requires confirm true. Irreversible.",
      inputSchema: z.object({
        instance_id: z.string().describe("Instance id"),
        confirm: z.literal(true).describe("Must be true. This permanently deletes the server."),
      }),
      annotations: { ...openWorld, destructiveHint: true, idempotentHint: true },
    },
    async ({ instance_id: instanceId }) => {
      await api.deleteInstance(instanceId);
      return { deleted: instanceId, note: "DNS records were not changed." };
    },
  );

  tool(
    "start-instance",
    {
      title: "Start instance",
      description: "Start a halted Vultr server. Starting it does not change DNS.",
      inputSchema: z.object({ instance_id: z.string().describe("Instance id") }),
      annotations: { ...openWorld, idempotentHint: true },
    },
    async ({ instance_id: instanceId }) => {
      await api.startInstance(instanceId);
      return { started: instanceId };
    },
  );

  tool(
    "halt-instance",
    {
      title: "Halt instance",
      description: "Stop a Vultr server. Vultr still bills a halted instance until you delete it.",
      inputSchema: z.object({ instance_id: z.string().describe("Instance id") }),
      annotations: { ...openWorld, idempotentHint: true },
    },
    async ({ instance_id: instanceId }) => {
      await api.haltInstance(instanceId);
      return { halted: instanceId, billing_note: "A halted instance is still billed until it is deleted." };
    },
  );

  tool(
    "reboot-instance",
    {
      title: "Reboot instance",
      description: "Reboot a Vultr server.",
      inputSchema: z.object({ instance_id: z.string().describe("Instance id") }),
      annotations: { ...openWorld, idempotentHint: false },
    },
    async ({ instance_id: instanceId }) => {
      await api.rebootInstance(instanceId);
      return { rebooted: instanceId };
    },
  );

  tool(
    "list-ssh-keys",
    {
      title: "List SSH keys",
      description: "List SSH public keys stored on the Vultr account.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    async () => api.listSshKeys(),
  );

  tool(
    "create-ssh-key",
    {
      title: "Create SSH key",
      description: "Save an OpenSSH public key to Vultr. This does not update servers that are already running.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Name shown in the Vultr portal"),
        ssh_key: z.string().describe('Public key, such as "ssh-ed25519 AAAA... comment"'),
      }),
      annotations: { ...openWorld, idempotentHint: false },
    },
    async ({ name, ssh_key: sshKey }) => {
      const trimmed = sshKey.trim();
      if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-|sk-ssh-|sk-ecdsa-)/.test(trimmed)) {
        throw new Error('ssh_key must be an OpenSSH public key, such as "ssh-ed25519 AAAA... comment".');
      }
      return api.createSshKey({ name, ssh_key: trimmed });
    },
  );

  return server;
}

function summarizeInstance(instance: Instance) {
  return {
    id: instance.id,
    label: instance.label,
    hostname: instance.hostname,
    main_ip: instance.main_ip,
    v6_main_ip: instance.v6_main_ip,
    region: instance.region,
    plan: instance.plan,
    os: instance.os,
    os_id: instance.os_id,
    status: instance.status,
    power_status: instance.power_status,
    tags: instance.tags,
    firewall_group_id: instance.firewall_group_id,
  };
}

function normalizeRecordWrite(
  input: { name: string; type: (typeof RECORD_TYPES)[number]; data: string; ttl?: number; priority?: number },
  zone: string,
): RecordWrite {
  const name = relativeRecordName(zone, input.name);
  const data = input.data.trim();
  if (!data) throw new Error("Record data cannot be empty.");
  if ((input.type === "MX" || input.type === "SRV") && input.priority === undefined) {
    throw new Error(`${input.type} records need a priority.`);
  }
  if (input.type === "A") assertIpv4(data);
  if (input.type === "AAAA") assertIpv6(data);
  return {
    name,
    type: input.type,
    data,
    ttl: input.ttl ?? 300,
    ...(input.priority === undefined ? {} : { priority: input.priority }),
  };
}
