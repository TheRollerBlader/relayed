#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";
import { VultrClient } from "./vultr.js";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(`vultr-domain-mcp

Point a domain you already own at Vultr DNS, and optionally create the cloud
server that answers for it. Vultr does not register domain names. After the
zone is published, set the registrar nameservers to ns1.vultr.com and
ns2.vultr.com.

Set VULTR_API_KEY in the environment. See examples/cursor-mcp.json.
`);
  process.exit(0);
}

const apiKey = process.env.VULTR_API_KEY;
if (!apiKey) {
  process.stderr.write(
    "VULTR_API_KEY is required. Create one at https://my.vultr.com/settings/#settingsapi and set it in the MCP server env.\n",
  );
  process.exit(1);
}

const client = new VultrClient({
  apiKey,
  ...(process.env.VULTR_API_BASE_URL ? { baseUrl: process.env.VULTR_API_BASE_URL } : {}),
});

void serveStdio(() => createServer(client));
process.stderr.write("vultr domain MCP server running on stdio\n");
