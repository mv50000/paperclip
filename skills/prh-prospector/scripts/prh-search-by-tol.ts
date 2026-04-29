/**
 * PRH-Prospector — yritysten haku TOL2008-toimialakoodilla.
 *
 * Käyttö:
 *   tsx skills/prh-prospector/scripts/prh-search-by-tol.ts <TOL5-koodi> [--city=<nimi>] [--postcode=<numero>] [--max=<N>]
 *
 * Esim:
 *   tsx skills/prh-prospector/scripts/prh-search-by-tol.ts 47910              # Postimyynti, koko Suomi
 *   tsx skills/prh-prospector/scripts/prh-search-by-tol.ts 47910 --city=HELSINKI  # client-side-suodatus kaupungilla
 *   tsx skills/prh-prospector/scripts/prh-search-by-tol.ts 47910 --postcode=00100 # PRH-API:n postCode-suodatus
 *   tsx skills/prh-prospector/scripts/prh-search-by-tol.ts 47910 --max=200        # max 200 tulosta
 *
 * HUOMIO: PRH-API:n `location`-parametri ei toimi kuntakoodilla. `postCode` toimii
 * yhdelle postinumerolle, mutta useimmiten `--city=...` (client-side-filter) on
 * helpoin tapa rajata kaupunkiin.
 *
 * Output: JSON-array stdoutiin (yksi rivi yritystä kohti, lyhennetty muoto).
 * Jos PAPERCLIP_COMPANY_ID env-vari asetettu, kirjoittaa myös jsonl-lokin.
 *
 * Rate-limit: 1 req/s, exponential backoff 429:n osuessa.
 */

import { mkdirSync, existsSync, appendFileSync } from "node:fs";

const PRH_BASE = "https://avoindata.prh.fi/opendata-ytj-api/v3/companies";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

interface PrhCompany {
  businessId: { value: string; registrationDate: string };
  names: Array<{ name: string; type: string; endDate?: string }>;
  mainBusinessLine?: {
    type: string;
    descriptions: Array<{ languageCode: string; description: string }>;
  };
  companyForms?: Array<{ descriptions: Array<{ languageCode: string; description: string }> }>;
  addresses: Array<{
    type: number;
    street?: string;
    buildingNumber?: string;
    postCode: string;
    postOffices: Array<{ city: string; languageCode: string; municipalityCode: string }>;
  }>;
  status: string;
  registeredEntries: Array<{ register: string; type: string }>;
  lastModified: string;
}

interface PrhResponse {
  totalResults: number;
  companies: PrhCompany[];
}

function parseArgs(argv: string[]): { tol: string; city?: string; postcode?: string; max: number } {
  const tol = argv[2];
  if (!tol || !/^\d{5}$/.test(tol)) {
    console.error("Käyttö: tsx prh-search-by-tol.ts <5-numeroinen TOL-koodi> [--city=NIMI] [--postcode=NNNNN] [--max=N]");
    console.error("HUOMIO: TOL2008-koodi 5-numeroinen ilman pisteitä. Esim '47.91' → '47910'.");
    process.exit(1);
  }
  let city: string | undefined;
  let postcode: string | undefined;
  let max = 1000;
  for (const arg of argv.slice(3)) {
    const [k, v] = arg.split("=");
    if (k === "--city") city = v?.toUpperCase();
    if (k === "--postcode") postcode = v;
    if (k === "--max") max = parseInt(v, 10);
  }
  return { tol, city, postcode, max };
}

async function fetchPage(tol: string, postcode: string | undefined, page: number, retries = 3): Promise<PrhResponse> {
  const params = new URLSearchParams({ mainBusinessLine: tol, page: String(page) });
  if (postcode) params.append("postCode", postcode);
  const url = `${PRH_BASE}?${params}`;

  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA } });
    if (res.ok) return res.json() as Promise<PrhResponse>;
    if (res.status === 429) {
      const delay = Math.pow(2, attempt) * 1000;
      console.error(`Rate-limit, odotetaan ${delay}ms (yritys ${attempt + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    throw new Error(`PRH API error ${res.status}: ${await res.text()}`);
  }
  throw new Error(`Liian monta uudelleenyritystä, sivu ${page}`);
}

function shorten(c: PrhCompany) {
  const visiting = c.addresses.find((a) => a.type === 1);
  const fi = visiting?.postOffices.find((p) => p.languageCode === "1") ?? visiting?.postOffices[0];
  const street = visiting?.street && visiting?.buildingNumber
    ? `${visiting.street} ${visiting.buildingNumber}`
    : visiting?.street ?? null;
  const activeName = c.names.find((n) => !n.endDate && n.type === "1")?.name
    ?? c.names.find((n) => !n.endDate)?.name
    ?? c.names[0]?.name;

  return {
    businessId: c.businessId.value,
    name: activeName,
    mainBusinessLine: c.mainBusinessLine
      ? {
          code: c.mainBusinessLine.type,
          description:
            c.mainBusinessLine.descriptions.find((d) => d.languageCode === "1")?.description ?? "",
        }
      : null,
    companyForm:
      c.companyForms?.[0]?.descriptions.find((d) => d.languageCode === "1")?.description ?? null,
    status: c.status === "2" ? "active" : "inactive",
    founded: c.businessId.registrationDate,
    location: fi
      ? { city: fi.city, postCode: visiting?.postCode, municipalityCode: fi.municipalityCode, street }
      : null,
    isVatRegistered: c.registeredEntries.some((r) => r.register === "6" && r.type === "80"),
    isEmployerRegistered: c.registeredEntries.some((r) => r.register === "7"),
    lastModified: c.lastModified,
  };
}

function logToCompany(companyId: string, payload: object) {
  const dir = `/var/lib/paperclip/prh-prospector/leads/${companyId}`;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = `${dir}/tol-search-${date}.jsonl`;
  appendFileSync(path, JSON.stringify({ ...payload, loggedAt: new Date().toISOString() }) + "\n");
}

async function main() {
  const { tol, city, postcode, max } = parseArgs(process.argv);
  const companyId = process.env.PAPERCLIP_COMPANY_ID;

  const all: ReturnType<typeof shorten>[] = [];
  let page = 1;
  let totalResults = 0;

  while (all.length < max) {
    const res = await fetchPage(tol, postcode, page);
    if (page === 1) totalResults = res.totalResults;
    if (res.companies.length === 0) break;

    for (const c of res.companies) {
      const s = shorten(c);
      if (city && s.location?.city !== city) continue;
      all.push(s);
      if (all.length >= max) break;
      if (companyId) {
        logToCompany(companyId, { source: "prh-search-by-tol", tol, city, postcode, company: s });
      }
    }

    if (res.companies.length < 100) break;
    page++;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const output = {
    query: { tol, city: city ?? null, postcode: postcode ?? null },
    totalResultsApi: totalResults,
    returned: all.length,
    companies: all,
    fetchedAt: new Date().toISOString(),
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: "search_failed", message: String(err) }));
  process.exit(3);
});
