// Default auto-reply templates seeded into every company on install.
//
// Variables (rendered by auto-reply.ts):
//   {{sender}}     — the inbound sender's full address
//   {{subject}}    — the original subject (may contain user input — keep it
//                    in plain prose, never inside attribute-like positions)
//   {{message_id}} — the Resend message id, useful for support tickets
//
// Locales we ship: fi (default), sv, en. Companies can override per-locale
// or add new locales without affecting these seed rows because the
// `email_templates_company_key_locale_unique_idx` UNIQUE makes the seed
// idempotent.

export interface DefaultTemplate {
  key: string;
  locale: string;
  subjectTpl: string;
  bodyMdTpl: string;
}

const SUPPORT_FI: DefaultTemplate = {
  key: "auto_reply.support",
  locale: "fi",
  subjectTpl: "Vahvistus: viestisi on vastaanotettu",
  bodyMdTpl: [
    "Kiitos viestistäsi.",
    "",
    "Pyrimme vastaamaan 24 tunnin sisällä. Aiheesi on tallennettu tikettiin viitenumeroin **{{message_id}}**.",
    "",
    "Jos asiasi on kiireellinen, mainitse \"KIIREELLINEN\" otsikossa kun lähetät uuden viestin.",
    "",
    "Ystävällisin terveisin",
    "Asiakaspalvelu",
    "",
    "_Tämä on automaattinen vastaus. Älä vastaa tähän viestiin._",
  ].join("\n"),
};

const SUPPORT_SV: DefaultTemplate = {
  key: "auto_reply.support",
  locale: "sv",
  subjectTpl: "Bekräftelse: ditt meddelande har mottagits",
  bodyMdTpl: [
    "Tack för ditt meddelande.",
    "",
    "Vi strävar efter att svara inom 24 timmar. Ditt ärende har sparats med referensnummer **{{message_id}}**.",
    "",
    "Med vänlig hälsning",
    "Kundtjänst",
    "",
    "_Detta är ett automatiskt svar. Vänligen svara inte på detta meddelande._",
  ].join("\n"),
};

const SUPPORT_EN: DefaultTemplate = {
  key: "auto_reply.support",
  locale: "en",
  subjectTpl: "Confirmation: your message has been received",
  bodyMdTpl: [
    "Thank you for your message.",
    "",
    "We aim to respond within 24 hours. Your request has been logged under reference **{{message_id}}**.",
    "",
    "Best regards",
    "Customer support",
    "",
    "_This is an automated reply. Please do not reply to this message._",
  ].join("\n"),
};

const ACCOUNTING_FI: DefaultTemplate = {
  key: "auto_reply.accounting",
  locale: "fi",
  subjectTpl: "Vahvistus: laskutusviestisi on vastaanotettu",
  bodyMdTpl: [
    "Kiitos viestistäsi.",
    "",
    "Laskutus- ja talousasiat käsitellään 2 työpäivän sisällä. Viitenumero: **{{message_id}}**.",
    "",
    "Ystävällisin terveisin",
    "Talousosasto",
    "",
    "_Tämä on automaattinen vastaus._",
  ].join("\n"),
};

const ACCOUNTING_SV: DefaultTemplate = {
  key: "auto_reply.accounting",
  locale: "sv",
  subjectTpl: "Bekräftelse: ditt fakturaärende har mottagits",
  bodyMdTpl: [
    "Tack för ditt meddelande.",
    "",
    "Faktureringsärenden behandlas inom 2 arbetsdagar. Referensnummer: **{{message_id}}**.",
    "",
    "Med vänlig hälsning",
    "Ekonomiavdelningen",
    "",
    "_Detta är ett automatiskt svar._",
  ].join("\n"),
};

const ACCOUNTING_EN: DefaultTemplate = {
  key: "auto_reply.accounting",
  locale: "en",
  subjectTpl: "Confirmation: your billing inquiry has been received",
  bodyMdTpl: [
    "Thank you for your message.",
    "",
    "Billing inquiries are processed within 2 business days. Reference: **{{message_id}}**.",
    "",
    "Best regards",
    "Accounting team",
    "",
    "_This is an automated reply._",
  ].join("\n"),
};

const GENERIC_FI: DefaultTemplate = {
  key: "auto_reply.generic",
  locale: "fi",
  subjectTpl: "Viestisi on vastaanotettu",
  bodyMdTpl: [
    "Kiitos yhteydenotosta.",
    "",
    "Olemme vastaanottaneet viestisi (viite **{{message_id}}**) ja palaamme asiaan pian.",
    "",
    "_Automaattinen vastaus._",
  ].join("\n"),
};

const GENERIC_SV: DefaultTemplate = {
  key: "auto_reply.generic",
  locale: "sv",
  subjectTpl: "Ditt meddelande har mottagits",
  bodyMdTpl: [
    "Tack för ditt meddelande.",
    "",
    "Vi har tagit emot ditt meddelande (referens **{{message_id}}**) och återkommer snart.",
    "",
    "_Automatiskt svar._",
  ].join("\n"),
};

const GENERIC_EN: DefaultTemplate = {
  key: "auto_reply.generic",
  locale: "en",
  subjectTpl: "Your message has been received",
  bodyMdTpl: [
    "Thank you for getting in touch.",
    "",
    "We have received your message (reference **{{message_id}}**) and will be in touch shortly.",
    "",
    "_Automated reply._",
  ].join("\n"),
};

export const DEFAULT_AUTO_REPLY_TEMPLATES: DefaultTemplate[] = [
  SUPPORT_FI,
  SUPPORT_SV,
  SUPPORT_EN,
  ACCOUNTING_FI,
  ACCOUNTING_SV,
  ACCOUNTING_EN,
  GENERIC_FI,
  GENERIC_SV,
  GENERIC_EN,
];
