/**
 * PRH-Prospector — yhden yrityksen rikastusdatan haku.
 *
 * Hakee PRH-perustiedot + yrittää löytää verkkosivun + hakee sen HTML:n
 * + lisää siihen referenssipromptin AI-rikastusta varten. Itse AI-analyysin
 * tekee agentti omalla Claude-mallillaan (skripti ei kutsu Anthropic SDK:ta).
 *
 * Käyttö:
 *   tsx skills/prh-prospector/scripts/enrich-fetch.ts <Y-tunnus> [--url=https://...]
 *
 * Esim:
 *   tsx skills/prh-prospector/scripts/enrich-fetch.ts 0114162-2
 *   tsx skills/prh-prospector/scripts/enrich-fetch.ts 0114162-2 --url=https://lindex.com
 *
 * Output: JSON stdoutiin, jsonl-loki jos PAPERCLIP_COMPANY_ID asetettu.
 *
 * GDPR: Skripti lukee vain etusivun HTML:n. Ei seuraa linkkejä, ei lue
 * yhteystiedot-sivua ellei pyyntö ole etusivu. Ei tallenna kuvia tai
 * binääridataa.
 */

import { mkdirSync, existsSync, appendFileSync } from "node:fs";

const PRH_BASE = "https://avoindata.prh.fi/opendata-ytj-api/v3/companies";
const Y_TUNNUS_RE = /^\d{7}-\d$/;
const MAX_HTML_BYTES = 250_000;
const FETCH_TIMEOUT_MS = 10_000;
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const HOSPITALITY_TOL_PREFIXES = ["551", "552", "553", "791", "792", "799"];

interface PrhMinimal {
  name: string;
  businessId: string;
  mainBusinessLine: string | null;
  mainBusinessLineCode: string | null;
  city: string | null;
  status: "active" | "inactive";
  founded: string;
  isVatRegistered: boolean;
  isEmployerRegistered: boolean;
}

async function fetchPrh(businessId: string): Promise<PrhMinimal | null> {
  const url = `${PRH_BASE}?businessId=${encodeURIComponent(businessId)}`;
  const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA } });
  if (!res.ok) throw new Error(`PRH API error ${res.status}`);
  const data: any = await res.json();
  if (data.totalResults === 0) return null;
  const c = data.companies[0];
  const visiting = c.addresses?.find((a: any) => a.type === 1)
    ?? c.addresses?.find((a: any) => a.type === 2);
  const fi = visiting?.postOffices?.find((p: any) => p.languageCode === "1");
  const activeName = c.names.find((n: any) => !n.endDate && n.type === "1")?.name
    ?? c.names.find((n: any) => !n.endDate)?.name
    ?? c.names[0]?.name;

  return {
    name: activeName,
    businessId: c.businessId.value,
    mainBusinessLine: c.mainBusinessLine?.descriptions
      ?.find((d: any) => d.languageCode === "1")?.description ?? null,
    mainBusinessLineCode: c.mainBusinessLine?.type ?? null,
    city: fi?.city ?? null,
    status: c.status === "2" ? "active" : "inactive",
    founded: c.businessId.registrationDate,
    isVatRegistered: c.registeredEntries?.some((r: any) => r.register === "6" && r.type === "80"),
    isEmployerRegistered: c.registeredEntries?.some((r: any) => r.register === "7"),
  };
}

function guessUrls(name: string, tolCode: string | null): string[] {
  const lower = name.toLowerCase();
  const urls: string[] = [];

  // 1. Detect TLD embedded in name (e.g. "Verkkokauppa.com Oyj" → "verkkokauppa.com")
  const tldMatch = lower.match(/([a-zåäö0-9-]+\.(?:com|fi|io|net|org|app|shop|tech|cloud|finland))\b/);
  if (tldMatch) {
    const domain = tldMatch[1].replace(/[åä]/g, "a").replace(/ö/g, "o");
    urls.push(`https://${domain}`, `https://www.${domain}`);
  }

  // 2. Strip company-form suffixes and special chars
  const slug = lower
    .replace(/\s+(oy ab|oy|oyj|ab|ay|ky|tmi|osk|ltd|kommandiittiyhtiö)\b.*$/i, "")
    .replace(/\s+(group|holding|finland|suomi|nordic)\b/i, "")
    .replace(/[^a-zåäö0-9]+/g, "")
    .replace(/å/g, "a")
    .replace(/ä/g, "a")
    .replace(/ö/g, "o");

  if (slug && slug.length >= 2) {
    urls.push(`https://${slug}.fi`, `https://www.${slug}.fi`);
    urls.push(`https://${slug}.com`, `https://www.${slug}.com`);
  }

  // 3. Hospitality fallback: hotels often live on booking.com
  if (tolCode && HOSPITALITY_TOL_PREFIXES.some((p) => tolCode.startsWith(p)) && slug) {
    urls.push(`https://www.booking.com/hotel/fi/${slug}.fi.html`);
  }

  // Deduplicate while preserving order
  return Array.from(new Set(urls));
}

interface FetchResult {
  url: string;
  status: number | null;
  finalUrl: string | null;
  title: string | null;
  metaDescription: string | null;
  htmlBytes: number;
  htmlTruncated: string;
  links: { type: string; url: string }[];
  fetchedAt: string;
  error?: string;
}

async function fetchWithTimeout(url: string): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fi-FI,fi;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
      },
      redirect: "follow",
      signal: ctrl.signal,
    });
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractMeta(html: string): { title: string | null; description: string | null; links: { type: string; url: string }[] } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)
    ?? html.match(/<meta\s+content=["']([^"']+)["']\s+name=["']description["']/i);

  const links: { type: string; url: string }[] = [];
  const socialPatterns: Array<[string, RegExp]> = [
    ["linkedin", /https?:\/\/(?:www\.)?linkedin\.com\/company\/[^"'\s<>]+/i],
    ["facebook", /https?:\/\/(?:www\.)?facebook\.com\/[^"'\s<>]+/i],
    ["instagram", /https?:\/\/(?:www\.)?instagram\.com\/[^"'\s<>/]+/i],
    ["twitter", /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^"'\s<>/]+/i],
    ["youtube", /https?:\/\/(?:www\.)?youtube\.com\/(?:c|channel|user|@)[^"'\s<>/]+/i],
    ["tiktok", /https?:\/\/(?:www\.)?tiktok\.com\/@[^"'\s<>/]+/i],
  ];
  for (const [type, re] of socialPatterns) {
    const m = html.match(re);
    if (m) links.push({ type, url: m[0] });
  }

  return {
    title: titleMatch?.[1]?.trim().replace(/\s+/g, " ") ?? null,
    description: descMatch?.[1]?.trim() ?? null,
    links,
  };
}

async function fetchSite(url: string): Promise<FetchResult> {
  const res = await fetchWithTimeout(url);
  if (!res) {
    return {
      url, status: null, finalUrl: null, title: null, metaDescription: null,
      htmlBytes: 0, htmlTruncated: "", links: [], fetchedAt: new Date().toISOString(),
      error: "fetch_timeout_or_dns",
    };
  }
  if (!res.ok) {
    return {
      url, status: res.status, finalUrl: res.url, title: null, metaDescription: null,
      htmlBytes: 0, htmlTruncated: "", links: [], fetchedAt: new Date().toISOString(),
      error: `http_${res.status}`,
    };
  }

  const buf = await res.arrayBuffer();
  const bytes = buf.byteLength;
  const slice = bytes > MAX_HTML_BYTES ? buf.slice(0, MAX_HTML_BYTES) : buf;
  const html = new TextDecoder().decode(slice);
  const meta = extractMeta(html);

  return {
    url,
    status: res.status,
    finalUrl: res.url,
    title: meta.title,
    metaDescription: meta.description,
    htmlBytes: bytes,
    htmlTruncated: html,
    links: meta.links,
    fetchedAt: new Date().toISOString(),
  };
}

function logToCompany(companyId: string, businessId: string, payload: object) {
  const dir = `/var/lib/paperclip/prh-prospector/leads/${companyId}`;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = `${dir}/${businessId}.jsonl`;
  appendFileSync(path, JSON.stringify({ ...payload, loggedAt: new Date().toISOString() }) + "\n");
}

const ENRICHMENT_PROMPT = `You are analysing a Finnish B2B company's website. Based on the HTML, the company name, and PRH register info, return a JSON object with the following keys:

- techStack: string[]   // detected technology (CMS, e-commerce platform, analytics, frameworks). Examples: ["Shopify", "GA4", "WordPress", "Hubspot"]. Empty array if no signals.
- socialMedia: { linkedin?: string; facebook?: string; instagram?: string; twitter?: string; youtube?: string; tiktok?: string }
- recruitmentSignals: { hasCareersPage: boolean; mentionedRoles: string[]; mentionedTech: string[] }
- eaaRelevance: "high" | "medium" | "low" | "none"   // EU Accessibility Act applicability based on customer-facing service nature
- eaaReasoning: string   // 1-2 sentences why
- industryTag: string   // a short Vainu-style custom industry classification, e.g. "fashion-retail-multinational" or "small-it-consultancy"
- confidence: "high" | "medium" | "low"

GDPR: Do NOT extract personal data (names, emails of individuals, phone numbers of specific persons). General company contact info (info@, sales@, switchboard) is OK.

Return ONLY the JSON, no commentary.`;

async function main() {
  const businessId = process.argv[2];
  if (!businessId || !Y_TUNNUS_RE.test(businessId)) {
    console.error("Käyttö: tsx enrich-fetch.ts <Y-tunnus> [--url=https://...]");
    process.exit(1);
  }
  const urlOverride = process.argv.slice(3).find((a) => a.startsWith("--url="))?.slice(6);

  const prh = await fetchPrh(businessId);
  if (!prh) {
    console.error(JSON.stringify({ error: "not_found", businessId }));
    process.exit(2);
  }

  let websiteResult: FetchResult | null = null;
  const candidates = urlOverride ? [urlOverride] : guessUrls(prh.name, prh.mainBusinessLineCode);
  for (const url of candidates) {
    const r = await fetchSite(url);
    if (r.status === 200 && r.htmlBytes > 1000) {
      websiteResult = r;
      break;
    }
    if (!websiteResult && r.status) websiteResult = r;
  }

  // Facebook page guess (small businesses often only have FB)
  const slug = prh.name
    .toLowerCase()
    .replace(/\s+(oy ab|oy|oyj|ab|ay|ky|tmi|osk)\b.*$/i, "")
    .replace(/[^a-zåäö0-9]+/g, "")
    .replace(/å/g, "a").replace(/ä/g, "a").replace(/ö/g, "o");
  let facebookGuess: { url: string; status: number | null; reachable: boolean } | null = null;
  if (slug && slug.length >= 3) {
    const fbUrl = `https://www.facebook.com/${slug}`;
    const fbRes = await fetchWithTimeout(fbUrl);
    facebookGuess = {
      url: fbUrl,
      status: fbRes?.status ?? null,
      reachable: !!fbRes && fbRes.status === 200,
    };
  }

  const output = {
    businessId,
    prh,
    website: websiteResult,
    facebookGuess,
    enrichmentPrompt: ENRICHMENT_PROMPT,
    triedUrls: candidates,
    fetchedAt: new Date().toISOString(),
  };

  console.log(JSON.stringify(output, null, 2));

  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  if (companyId) {
    logToCompany(companyId, businessId, {
      source: "prh-enrich-fetch",
      businessId,
      prh,
      website: websiteResult ? { ...websiteResult, htmlTruncated: undefined } : null,
    });
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: "enrichment_failed", message: String(err) }));
  process.exit(3);
});
