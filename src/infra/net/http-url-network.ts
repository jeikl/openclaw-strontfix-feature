/**
 * Dual-DNS classification for http(s) media URLs.
 *
 * Resolves hostname via:
 * 1) system DNS (default resolver)
 * 2) public resolvers (1.1.1.1 + 8.8.8.8)
 *
 * If **any** resolved address is a global/public IP → treat as **public**.
 * If only private/special-use addresses are seen → **private**.
 * If no usable answers → **unknown**.
 *
 * Used by image tool (prefer pass-through public URL to vision APIs)
 * and can inform web_fetch SSRF decisions.
 */
import { lookup as dnsLookup, Resolver } from "node:dns/promises";
import { normalizeHostname } from "./hostname.js";
import { isPrivateIpAddress } from "./ssrf.js";

export type HttpUrlNetworkClass = "public" | "private" | "unknown";

export type HttpUrlNetworkClassification = {
  class: HttpUrlNetworkClass;
  hostname: string;
  systemAddresses: string[];
  publicDnsAddresses: string[];
};

const PUBLIC_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"] as const;
const LOOKUP_TIMEOUT_MS = 3_000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`DNS lookup timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function lookupAllSystem(hostname: string): Promise<string[]> {
  try {
    const results = await withTimeout(
      dnsLookup(hostname, { all: true, verbatim: true }),
      LOOKUP_TIMEOUT_MS,
    );
    return results.map((r) => r.address).filter(Boolean);
  } catch {
    return [];
  }
}

async function lookupAllPublicDns(hostname: string): Promise<string[]> {
  const resolver = new Resolver();
  resolver.setServers([...PUBLIC_DNS_SERVERS]);
  const out = new Set<string>();
  try {
    const [v4, v6] = await Promise.all([
      withTimeout(
        resolver.resolve4(hostname).catch(() => [] as string[]),
        LOOKUP_TIMEOUT_MS,
      ),
      withTimeout(
        resolver.resolve6(hostname).catch(() => [] as string[]),
        LOOKUP_TIMEOUT_MS,
      ),
    ]);
    for (const a of v4) out.add(a);
    for (const a of v6) out.add(a);
  } catch {
    /* ignore */
  }
  return [...out];
}

function isPublicAddress(address: string): boolean {
  // isPrivateIpAddress true → private/special-use; false for global unicast (and non-IP hostnames)
  if (!address) return false;
  // Literals only — hostnames should already be resolved to IPs here.
  if (isPrivateIpAddress(address)) return false;
  // Reject empty / clearly not IP
  if (!address.includes(".") && !address.includes(":")) return false;
  return true;
}

/**
 * Classify an http(s) URL by dual DNS.
 * Non-http(s) or invalid → unknown.
 */
export async function classifyHttpUrlNetwork(
  rawUrl: string,
): Promise<HttpUrlNetworkClassification> {
  let hostname = "";
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return {
        class: "unknown",
        hostname: "",
        systemAddresses: [],
        publicDnsAddresses: [],
      };
    }
    hostname = normalizeHostname(u.hostname) || u.hostname;
  } catch {
    return {
      class: "unknown",
      hostname: "",
      systemAddresses: [],
      publicDnsAddresses: [],
    };
  }

  // Literal IP host — no DNS needed
  if (isPrivateIpAddress(hostname)) {
    return {
      class: "private",
      hostname,
      systemAddresses: [hostname],
      publicDnsAddresses: [],
    };
  }
  // If hostname is a public IP literal
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) {
    if (!isPrivateIpAddress(hostname) && (hostname.includes(".") || hostname.includes(":"))) {
      // Could still be malformed; isPrivateIpAddress false for global IPv4
      const looksIp =
        /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ||
        (hostname.includes(":") && !hostname.includes(" "));
      if (looksIp) {
        return {
          class: isPublicAddress(hostname) ? "public" : "private",
          hostname,
          systemAddresses: [hostname],
          publicDnsAddresses: [hostname],
        };
      }
    }
  }

  const [systemAddresses, publicDnsAddresses] = await Promise.all([
    lookupAllSystem(hostname),
    lookupAllPublicDns(hostname),
  ]);

  const all = [...systemAddresses, ...publicDnsAddresses];
  if (all.length === 0) {
    return {
      class: "unknown",
      hostname,
      systemAddresses,
      publicDnsAddresses,
    };
  }

  const anyPublic = all.some((a) => isPublicAddress(a));
  return {
    class: anyPublic ? "public" : "private",
    hostname,
    systemAddresses,
    publicDnsAddresses,
  };
}

/** True when dual-DNS classifies the URL as public. */
export async function isPublicHttpUrl(rawUrl: string): Promise<boolean> {
  const result = await classifyHttpUrlNetwork(rawUrl);
  return result.class === "public";
}
