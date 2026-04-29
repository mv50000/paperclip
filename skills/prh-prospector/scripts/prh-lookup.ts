/**
 * PRH-Prospector — yksittäisen yrityksen lookup Y-tunnuksella tai nimellä.
 *
 * Käyttö:
 *   tsx skills/prh-prospector/scripts/prh-lookup.ts <Y-tunnus|nimi>
 *
 * Esim:
 *   tsx skills/prh-prospector/scripts/prh-lookup.ts 0114162-2
 *   tsx skills/prh-prospector/scripts/prh-lookup.ts "Stockmann"
 *
 * Output: JSON stdoutiin. Jos COMPANY_ID env-vari asetettu, jsonl-loki
 * polkuun /var/lib/paperclip/prh-prospector/leads/{companyId}/{Y-tunnus}.jsonl.
 */

import { writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

const PRH_BASE = "https://avoindata.prh.fi/opendata-ytj-api/v3/companies";
const Y_TUNNUS_RE = /^\d{7}-\d$/;
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

interface PrhRawCompany {
  businessId: { value: string; registrationDate: string; source: string };
  euId?: { value: string; source: string };
  names: Array<{
    name: string;
    type: string;
    registrationDate: string;
    endDate?: string;
    version: number;
  }>;
  mainBusinessLine?: {
    type: string;
    descriptions: Array<{ languageCode: string; description: string }>;
    typeCodeSet: string;
    registrationDate?: string;
  };
  companyForms?: Array<{
    type: string;
    descriptions: Array<{ languageCode: string; description: string }>;
    registrationDate: string;
  }>;
  registeredEntries: Array<{
    type: string;
    descriptions: Array<{ languageCode: string; description: string }>;
    register: string;
    authority: string;
    registrationDate: string;
  }>;
  addresses: Array<{
    type: number;
    street?: string;
    buildingNumber?: string;
    entrance?: string;
    apartmentNumber?: string;
    postCode: string;
    postOffices: Array<{ city: string; languageCode: string; municipalityCode: string }>;
    postOfficeBox?: string;
    registrationDate: string;
  }>;
  status: string;
  registrationDate: string;
  lastModified: string;
}

interface PrhResponse {
  totalResults: number;
  companies: PrhRawCompany[];
}

interface NormalizedCompany {
  businessId: string;
  euId: string | null;
  names: { primary: string; aliases: string[]; previous: string[] };
  mainBusinessLine: { code: string; description: string } | null;
  companyForm: string | null;
  status: "active" | "inactive";
  founded: string;
  lastModified: string;
  addresses: Array<{
    type: "visiting" | "postal";
    street: string | null;
    postCode: string;
    city: string;
    municipalityCode: string;
  }>;
  registers: Array<{
    register: string;
    description: string;
    registrationDate: string;
  }>;
}

const REGISTER_NAMES: Record<string, string> = {
  "1": "Kaupparekisteri",
  "4": "EU-LEI",
  "5": "Ennakkoperintärekisteri",
  "6": "ALV-rekisteri",
  "7": "Työnantajarekisteri",
};

const STATUS_MAP: Record<string, "active" | "inactive"> = {
  "1": "inactive",
  "2": "active",
};

function pickFi(descriptions: Array<{ languageCode: string; description: string }>): string {
  return descriptions.find((d) => d.languageCode === "1")?.description
    ?? descriptions[0]?.description
    ?? "";
}

function normalizeAddress(addr: PrhRawCompany["addresses"][0]) {
  const fi = addr.postOffices.find((p) => p.languageCode === "1") ?? addr.postOffices[0];
  let streetParts: string[] = [];
  if (addr.street) streetParts.push(addr.street);
  if (addr.buildingNumber) streetParts.push(addr.buildingNumber);
  if (addr.entrance) streetParts.push(addr.entrance);
  if (addr.apartmentNumber) streetParts.push(`as. ${addr.apartmentNumber}`);
  if (addr.postOfficeBox) streetParts.push(`PL ${addr.postOfficeBox}`);
  return {
    type: addr.type === 1 ? "visiting" : "postal" as const,
    street: streetParts.length > 0 ? streetParts.join(" ") : null,
    postCode: addr.postCode,
    city: fi?.city ?? "",
    municipalityCode: fi?.municipalityCode ?? "",
  };
}

function normalize(c: PrhRawCompany): NormalizedCompany {
  const activeNames = c.names.filter((n) => !n.endDate);
  const previousNames = c.names.filter((n) => n.endDate);

  const sortedPrev = [...previousNames].sort((a, b) =>
    (b.endDate ?? "").localeCompare(a.endDate ?? "")
  );
  const primary = activeNames.find((n) => n.type === "1")?.name
    ?? activeNames[0]?.name
    ?? sortedPrev[0]?.name
    ?? "(unknown)";
  const aliases = activeNames.filter((n) => n.type !== "1").map((n) => n.name);
  const previous = sortedPrev.map((n) => n.name);

  return {
    businessId: c.businessId.value,
    euId: c.euId?.value ?? null,
    names: { primary, aliases, previous },
    mainBusinessLine: c.mainBusinessLine
      ? { code: c.mainBusinessLine.type, description: pickFi(c.mainBusinessLine.descriptions) }
      : null,
    companyForm: c.companyForms?.[0] ? pickFi(c.companyForms[0].descriptions) : null,
    status: STATUS_MAP[c.status] ?? "inactive",
    founded: c.businessId.registrationDate,
    lastModified: c.lastModified,
    addresses: c.addresses.map(normalizeAddress),
    registers: c.registeredEntries.map((r) => ({
      register: REGISTER_NAMES[r.register] ?? `register-${r.register}`,
      description: pickFi(r.descriptions),
      registrationDate: r.registrationDate,
    })),
  };
}

async function fetchPrh(query: string): Promise<PrhResponse> {
  const isBusinessId = Y_TUNNUS_RE.test(query);
  const param = isBusinessId
    ? `businessId=${encodeURIComponent(query)}`
    : `name=${encodeURIComponent(query)}`;
  const url = `${PRH_BASE}?${param}`;
  const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA } });
  if (!res.ok) {
    throw new Error(`PRH API error ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<PrhResponse>;
}

function logToCompany(companyId: string, businessId: string, payload: unknown) {
  const dir = `/var/lib/paperclip/prh-prospector/leads/${companyId}`;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = `${dir}/${businessId}.jsonl`;
  appendFileSync(path, JSON.stringify({ ...(payload as object), loggedAt: new Date().toISOString() }) + "\n");
}

async function main() {
  const query = process.argv[2];
  if (!query) {
    console.error("Käyttö: tsx prh-lookup.ts <Y-tunnus|nimi>");
    process.exit(1);
  }

  const data = await fetchPrh(query);
  if (data.totalResults === 0) {
    console.error(JSON.stringify({ error: "not_found", query }));
    process.exit(2);
  }

  const normalized = data.companies.map(normalize);
  const output = {
    query,
    totalResults: data.totalResults,
    returned: normalized.length,
    companies: normalized,
    fetchedAt: new Date().toISOString(),
  };

  console.log(JSON.stringify(output, null, 2));

  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  if (companyId) {
    for (const c of normalized) {
      logToCompany(companyId, c.businessId, { source: "prh-lookup", company: c });
    }
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: "fetch_failed", message: String(err) }));
  process.exit(3);
});
