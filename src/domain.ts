import { isIP } from "node:net";
import { domainToASCII } from "node:url";

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_NAME = new RegExp(`^(?:${LABEL}\\.)+[a-z]{2,}$`);
const RELATIVE_NAME = new RegExp(`^(?:\\*|(?:\\*\\.)?${LABEL}(?:\\.${LABEL})*)$`);

export function normalizeDomain(input: string): string {
  const trimmed = input.trim().toLowerCase().replace(/\.+$/, "");
  if (trimmed.includes("://") || trimmed.includes("/") || trimmed.includes(" ")) {
    throw new Error(
      `"${input}" is not a domain name. Use a name like example.com, with no https:// and no path.`,
    );
  }

  const ascii = domainToASCII(trimmed);
  if (!ascii || ascii.length > 253 || !DOMAIN_NAME.test(ascii)) {
    throw new Error(
      `"${input}" is not a domain name. Use a name like example.com, with no https:// and no path.`,
    );
  }
  return ascii;
}

export function relativeRecordName(domain: string, name: string): string {
  const zone = normalizeDomain(domain);
  const raw = name.trim().toLowerCase().replace(/\.+$/, "");
  if (raw === "" || raw === "@" || raw === zone) return "";

  const suffix = `.${zone}`;
  const relative = raw.endsWith(suffix) ? raw.slice(0, -suffix.length) : raw;
  if (!relative || !RELATIVE_NAME.test(relative)) {
    throw new Error(
      `Record name "${name}" is not valid under ${zone}. Use @ for the apex or a relative name like www.`,
    );
  }
  return relative;
}

export function sameRecordName(domain: string, actual: string, expectedRelative: string): boolean {
  try {
    return relativeRecordName(domain, actual) === expectedRelative;
  } catch {
    return false;
  }
}

export function displayRecordName(name: string): string {
  return name === "" ? "@" : name;
}

export function assertIpv4(value: string): string {
  const ip = value.trim();
  if (isIP(ip) !== 4) throw new Error(`"${value}" is not an IPv4 address.`);
  if (ip === "0.0.0.0") throw new Error("0.0.0.0 is not a usable address.");
  return ip;
}

export function assertIpv6(value: string): string {
  const ip = value.trim();
  if (isIP(ip) !== 6) throw new Error(`"${value}" is not an IPv6 address.`);
  if (ip === "::" || ip === "::0") throw new Error(`${ip} is not a usable address.`);
  return ip;
}

export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  const a = parts[0];
  const b = parts[1];
  if (a === undefined || b === undefined) return false;
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}
