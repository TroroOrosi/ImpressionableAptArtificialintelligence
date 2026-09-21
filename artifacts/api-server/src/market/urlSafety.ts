import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 8_000;
export const publicFetchPolicy = {
  maxResponseBytes: MAX_RESPONSE_BYTES,
  maxRedirects: MAX_REDIRECTS,
  timeoutMs: FETCH_TIMEOUT_MS,
} as const;

const defaultTrustedDomains = new Set([
  "shopping.yahoo.co.jp", "auctions.yahoo.co.jp", "paypayfleamarket.yahoo.co.jp",
  "rakuten.co.jp", "item.rakuten.co.jp", "mercari.com", "jp.mercari.com",
  "fril.jp", "ebay.com", "www.ebay.com", "amazon.co.jp", "keepa.com",
  "pcgs.com", "www.pcgs.com", "tcgplayer.com", "www.tcgplayer.com",
  "chrono24.jp", "www.chrono24.jp", "gia.edu", "www.gia.edu",
  "artnet.com", "www.artnet.com", "stockx.com", "stockx.com",
]);
const runtimeTrustedDomains = new Set<string>();

const metadataHosts = new Set([
  "metadata.google.internal", "metadata.google", "instance-data.ec2.internal",
  "metadata.azure.internal", "169.254.169.254", "100.100.100.200",
]);

function parseIpv4(address: string) {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? parts : null;
}

export function isForbiddenIp(address: string): boolean {
  if (isIP(address) === 4) {
    const p = parseIpv4(address)!;
    return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19)) ||
      p[0] >= 224;
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase().split("%")[0] || "";
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd") ||
        /^fe[89ab]/.test(normalized) || normalized.startsWith("ff")) return true;
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return mapped ? isForbiddenIp(mapped) : false;
  }
  return true;
}

export function isTrustedDomain(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return [...defaultTrustedDomains, ...runtimeTrustedDomains]
    .some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function addTrustedDomain(domain: string) {
  const normalized = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalized)) {
    throw new Error("invalid_domain");
  }
  if (metadataHosts.has(normalized) || normalized === "localhost") throw new Error("forbidden_domain");
  runtimeTrustedDomains.add(normalized);
  return normalized;
}

export async function validatePublicUrl(raw: string, requireTrustedDomain = true) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("invalid_url"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported_scheme");
  if (url.username || url.password) throw new Error("credentials_not_allowed");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || metadataHosts.has(hostname)) {
    throw new Error("forbidden_host");
  }
  if (isIP(hostname) && isForbiddenIp(hostname)) throw new Error("forbidden_ip");
  if (requireTrustedDomain && !isTrustedDomain(hostname)) throw new Error("unsupported_domain");
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isForbiddenIp(address))) throw new Error("unsafe_dns_resolution");
  return url;
}

export async function validateRedirectTarget(location: string, current: URL) {
  return validatePublicUrl(new URL(location, current).href);
}

export async function readBodyLimited(response: Response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("response_too_large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("response_too_large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

export async function safeFetchPublicUrl(raw: string) {
  let current = await validatePublicUrl(raw);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "MarketIntelMCP/1.0 (+read-only verification)", accept: "text/html,application/xhtml+xml" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === MAX_REDIRECTS) throw new Error("redirect_limit");
      current = await validateRedirectTarget(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`upstream_${response.status}`);
    return { response, body: await readBodyLimited(response), finalUrl: current };
  }
  throw new Error("redirect_limit");
}