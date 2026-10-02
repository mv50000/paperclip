export interface CompanyTarget {
  name: string;
  displayName: string;
  baseUrl: string;
  /** Paperclip company slug used when creating tickets for failures. */
  paperclipCompany: string;
  /** Agent (or role) responsible for fixing breakages — populated as ticket assignee. */
  ownerAgent: string;
  /** True when the app's home page redirects to /login or similar when unauthenticated. */
  authRedirects: boolean;
}

const ALL_COMPANIES: CompanyTarget[] = [
  {
    name: "ololla",
    displayName: "Ololla (booking-killer)",
    baseUrl: "https://ololla-dev.rk9.fi",
    paperclipCompany: "ololla",
    ownerAgent: "ololla-tech-lead",
    authRedirects: false,
  },
  {
    name: "alli-audit",
    displayName: "Alli-Audit",
    baseUrl: "https://alli-audit-dev.rk9.fi",
    paperclipCompany: "alli-audit",
    ownerAgent: "alli-audit-tech-lead",
    authRedirects: true,
  },
  {
    name: "quantimodo",
    displayName: "Quantimodo",
    baseUrl: "https://quantimodo-dev.rk9.fi",
    paperclipCompany: "quantimodo",
    ownerAgent: "quantimodo-tech-lead",
    authRedirects: false,
  },
  {
    name: "saatavilla",
    displayName: "Saatavilla",
    baseUrl: "https://saatavilla-dev.rk9.fi",
    paperclipCompany: "saatavilla",
    ownerAgent: "saatavilla-tech-lead",
    authRedirects: false,
  },
  {
    name: "sunspot",
    displayName: "Sunspot",
    baseUrl: "https://sunspot-dev.rk9.fi",
    paperclipCompany: "sunspot",
    ownerAgent: "sunspot-tech-lead",
    authRedirects: false,
  },
  {
    name: "uutisvertailu",
    displayName: "Uutisvertailu",
    baseUrl: "https://uutisvertailu-dev.rk9.fi",
    paperclipCompany: "uutisvertailu",
    ownerAgent: "uutisvertailu-tech-lead",
    authRedirects: false,
  },
  {
    name: "last-shadow",
    displayName: "Last Shadow (TLN Games)",
    baseUrl: "https://tln-dev.rk9.fi",
    paperclipCompany: "last-shadow",
    ownerAgent: "last-shadow-tech-lead",
    authRedirects: false,
  },
];

/**
 * Comma-separated company names to leave out of the run, e.g. a parked app whose dev
 * instance is down (`E2E_COMPANIES_SKIP=uutisvertailu`). Applies to both Playwright
 * projects and the failure report.
 */
const SKIPPED = new Set(
  (process.env.E2E_COMPANIES_SKIP ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
);

export const COMPANIES: CompanyTarget[] = ALL_COMPANIES.filter((co) => !SKIPPED.has(co.name));

export function companyByName(name: string): CompanyTarget {
  const co = COMPANIES.find((c) => c.name === name);
  if (!co) throw new Error(`Unknown company: ${name}`);
  return co;
}
