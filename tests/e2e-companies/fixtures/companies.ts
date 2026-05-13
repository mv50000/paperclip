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

export const COMPANIES: CompanyTarget[] = [
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
];

export function companyByName(name: string): CompanyTarget {
  const co = COMPANIES.find((c) => c.name === name);
  if (!co) throw new Error(`Unknown company: ${name}`);
  return co;
}
