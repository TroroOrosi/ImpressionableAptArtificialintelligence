import { createHash } from "node:crypto";

export type VerificationStatus = "VERIFIED_STRONG" | "VERIFIED_SINGLE" | "CONFLICT" | "STALE" | "UNVERIFIED";
export type Identity = Record<string, string | string[] | null | undefined>;
export type Evidence = {
  value: number; currency: string; fetched_at: string; freshness_seconds: number;
  remaining_seconds?: number | null; source?: string; source_tier?: number;
  evidence_hash?: string; url?: string; [key: string]: unknown;
};

const configured = (env?: string) => !env || Boolean(process.env[env]);
export const providerRegistry = [
  { id: "yahoo-shopping", label: "Yahoo!ショッピング API", tier: 1, kind: "official", env: "YAHOO_CLIENT_ID" },
  { id: "rakuten", label: "楽天市場 API", tier: 1, kind: "official", env: "RAKUTEN_APP_ID" },
  { id: "ebay", label: "eBay Browse API", tier: 1, kind: "official", env: "EBAY_CLIENT_ID" },
  { id: "amazon", label: "Amazon Creators API", tier: 1, kind: "official", env: "AMAZON_CREATORS_KEY" },
  { id: "keepa", label: "Keepa", tier: 2, kind: "specialist", env: "KEEPA_API_KEY" },
  { id: "serpapi", label: "SerpApi Google Shopping", tier: 3, kind: "discovery", env: "SERPAPI_KEY" },
  { id: "apify", label: "Apify Marketplace Actors", tier: 4, kind: "marketplace", env: "APIFY_TOKEN" },
  { id: "brightdata", label: "Bright Data", tier: 5, kind: "fallback", env: "BRIGHT_DATA_TOKEN" },
  { id: "jsonld", label: "JSON-LD / Schema.org", tier: 6, kind: "generic" },
  { id: "playwright", label: "Playwright (最終手段)", tier: 7, kind: "browser", env: "ENABLE_PLAYWRIGHT" },
].map((p) => ({ ...p, configured: configured(p.env) }));

const fields = ["jan", "gtin", "asin", "mpn", "model", "capacity", "color", "region", "version", "year", "condition", "grade", "cert_company", "cert_number"];
export function compareIdentity(a: Identity, b: Identity) {
  const mismatches = fields.filter((k) => a[k] && b[k] && String(a[k]).toLowerCase() !== String(b[k]).toLowerCase());
  return { match: mismatches.length === 0, mismatches };
}

export const auctionFreshnessLimit = (remaining?: number | null) =>
  remaining != null && remaining <= 600 ? 120 : remaining != null && remaining <= 1800 ? 300 : 1800;

export function verifyEvidence(items: Evidence[]) {
  if (!items.length) return { status: "UNVERIFIED" as const, actionable: false, reason: "価格観測がありません" };
  const uniquePayloads = new Map<string, Evidence>();
  for (const item of items) {
    const payloadKey = item.evidence_hash || evidenceHash([item.source, item.url, item.value, item.currency, item.fetched_at]);
    if (!uniquePayloads.has(payloadKey)) uniquePayloads.set(payloadKey, item);
  }
  const deduped = [...uniquePayloads.values()];
  if (deduped.some((i) => i.freshness_seconds > auctionFreshnessLimit(i.remaining_seconds))) {
    return { status: "STALE" as const, actionable: false, reason: "鮮度ポリシーを満たしていません" };
  }
  const min = Math.min(...deduped.map((i) => i.value));
  const max = Math.max(...deduped.map((i) => i.value));
  if (max > min * 1.08) return { status: "CONFLICT" as const, actionable: false, reason: "重要な価格差があります" };
  const sources = new Set(deduped.map((i) => (i.source || new URL(i.url || "https://unknown.invalid").hostname).toLowerCase()));
  const hasAuthoritative = deduped.some((i) => i.source_tier === 1);
  const independent = sources.size >= 2;
  const strong = independent && (deduped.length >= 2 || hasAuthoritative);
  const status = strong ? "VERIFIED_STRONG" as const : "VERIFIED_SINGLE" as const;
  return { status, actionable: true, reason: strong ? "独立した複数ソースが合意" : "重複を除外した単一ソース観測" };
}

export function isActionable(status: VerificationStatus, freshness: number, remaining?: number | null) {
  return (status === "VERIFIED_STRONG" || status === "VERIFIED_SINGLE") && freshness <= auctionFreshnessLimit(remaining);
}

export const evidenceHash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");

export function computeCoverage(sources: Array<{ configured: boolean; searchable: boolean; live_price_capable: boolean; sold_comps_capable: boolean }>) {
  const n = sources.length || 1;
  return {
    registry_size: sources.length,
    configured_count: sources.filter((s) => s.configured).length,
    searchable_count: sources.filter((s) => s.searchable).length,
    live_price_count: sources.filter((s) => s.live_price_capable).length,
    sold_comps_count: sources.filter((s) => s.sold_comps_capable).length,
    measured_coverage_percent: Math.round((sources.filter((s) => s.configured).length / n) * 1000) / 10,
    disclaimer: "インターネット全体ではなく、登録済み trusted-source registry に対する実測カバレッジです。",
  };
}