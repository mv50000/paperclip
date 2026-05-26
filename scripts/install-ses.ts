// Idempotentti install-skripti Amazon SES -integraatiolle (SEC-107/L3).
// Vastine scripts/install-resend-skill.ts:lle, mutta SES-providerille.
//
// Käyttö:
//   pnpm tsx scripts/install-ses.ts \
//     --company-id <uuid> \
//     --primary-domain sunspot.fi \
//     --sending-domain sunspot.fi \
//     [--region eu-west-1] \
//     [--default-from-name "Sunspot"] \
//     [--max-per-agent-per-day 50] \
//     [--max-per-company-per-day 500]
//
//   pnpm tsx scripts/install-ses.ts --company-id <uuid> --verify
//     - Pollaa SES-identiteetin DKIM/verifiointistatuksen ja flippaa
//       company_email_config.status arvoon 'verified' kun kaikki valmista.
//
// SES käyttää domain-nimeä identiteettinä (ei erillistä id:tä kuten Resend).
// Credentialit luetaan ympäristöstä (SES_REGION/AWS_*); skripti EI koske
// company_secretseihin. Luo SES-identiteetti + Easy DKIM ensin (konsoli / aws cli),
// aja sitten tämä → tulostaa julkaistavat DNS-tietueet.

import { eq } from "drizzle-orm";
import { createDb, companyEmailConfig, companies } from "@paperclipai/db";
import { SesProvider, sesConfigFromEnv } from "../server/src/services/email/ses-client.js";
import { seedDefaultTemplates } from "../server/src/services/email/template-seed.js";

interface Args {
  companyId: string;
  primaryDomain?: string;
  sendingDomain?: string;
  region?: string;
  defaultFromName?: string;
  maxPerAgentPerDay?: number;
  maxPerCompanyPerDay?: number;
  verify: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> & { verify: boolean } = { verify: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case "--company-id": out.companyId = next; i++; break;
      case "--primary-domain": out.primaryDomain = next; i++; break;
      case "--sending-domain": out.sendingDomain = next; i++; break;
      case "--region": out.region = next; i++; break;
      case "--default-from-name": out.defaultFromName = next; i++; break;
      case "--max-per-agent-per-day": out.maxPerAgentPerDay = Number(next); i++; break;
      case "--max-per-company-per-day": out.maxPerCompanyPerDay = Number(next); i++; break;
      case "--verify": out.verify = true; break;
    }
  }
  if (!out.companyId) throw new Error("--company-id required");
  return out as Args;
}

function resolveRegion(arg?: string): string {
  const region = arg ?? process.env.SES_REGION ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) throw new Error("region required: pass --region or set SES_REGION/AWS_REGION");
  return region;
}

function makeProvider(region: string): SesProvider {
  const cfg = sesConfigFromEnv();
  return new SesProvider({ ...cfg, region });
}

/** Print the DNS records the operator must publish for `sendingDomain`/`primaryDomain`. */
function printDnsRecords(
  region: string,
  primaryDomain: string,
  sendingDomain: string,
  dkim: Array<{ type: string; name: string; value: string; status: string }>,
) {
  console.log("\nDNS-tietueet (julkaise domainin JULKISEEN auktoritatiiviseen zoneen):");
  if (dkim.length > 0) {
    for (const r of dkim) console.log(`  ${r.type.padEnd(5)} ${r.name}  ->  ${r.value}  [${r.status}]`);
  } else {
    console.log("  (DKIM-tietueita ei saatu SES:stä — luo identiteetti + Easy DKIM ensin)");
  }
  console.log(`  MX    mail.${sendingDomain}  ->  10 feedback-smtp.${region}.amazonses.com   (MAIL FROM)`);
  console.log(`  TXT   mail.${sendingDomain}  ->  "v=spf1 include:amazonses.com ~all"        (MAIL FROM SPF)`);
  console.log(`  TXT   _dmarc.${sendingDomain}  ->  "v=DMARC1; p=none; rua=mailto:dmarc@${sendingDomain}"`);
  console.log(`  MX    ${primaryDomain}  ->  10 inbound-smtp.${region}.amazonaws.com         (saapuva, vasta L5-cutoverissa)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = await createDb();

  const [company] = await db.select().from(companies).where(eq(companies.id, args.companyId));
  if (!company) {
    console.error(`company ${args.companyId} not found`);
    process.exit(2);
  }

  if (args.verify) {
    await runVerify(db, args.companyId, args.region);
    return;
  }

  if (!args.primaryDomain || !args.sendingDomain) {
    console.error("first install requires --primary-domain and --sending-domain");
    process.exit(2);
  }
  const region = resolveRegion(args.region);

  const [existing] = await db
    .select()
    .from(companyEmailConfig)
    .where(eq(companyEmailConfig.companyId, args.companyId));

  if (existing) {
    await db
      .update(companyEmailConfig)
      .set({
        primaryDomain: args.primaryDomain,
        sendingDomain: args.sendingDomain,
        mailProvider: "ses",
        resendDomainId: null,
        defaultFromName: args.defaultFromName ?? existing.defaultFromName,
        maxPerAgentPerDay: args.maxPerAgentPerDay ?? existing.maxPerAgentPerDay,
        maxPerCompanyPerDay: args.maxPerCompanyPerDay ?? existing.maxPerCompanyPerDay,
        updatedAt: new Date(),
      })
      .where(eq(companyEmailConfig.companyId, args.companyId));
    console.log(`updated company_email_config for ${company.name} -> provider=ses (status preserved)`);
  } else {
    await db.insert(companyEmailConfig).values({
      companyId: args.companyId,
      primaryDomain: args.primaryDomain,
      sendingDomain: args.sendingDomain,
      mailProvider: "ses",
      resendDomainId: null,
      defaultFromName: args.defaultFromName,
      status: "pending",
      maxPerAgentPerDay: args.maxPerAgentPerDay ?? 50,
      maxPerCompanyPerDay: args.maxPerCompanyPerDay ?? 500,
    });
    console.log(`created company_email_config for ${company.name} -> provider=ses (status=pending)`);
  }

  const seed = await seedDefaultTemplates(db, args.companyId);
  console.log(`templates: inserted=${seed.inserted.length} skipped=${seed.skipped.length} (idempotent)`);

  // Best-effort: fetch DKIM records from SES to print. The identity must already
  // exist; if not, we still print the static MAIL FROM / DMARC / inbound records.
  let dkim: Array<{ type: string; name: string; value: string; status: string }> = [];
  const result = await makeProvider(region).getDomainStatus(args.sendingDomain);
  if (result.ok) {
    dkim = result.domain.records;
  } else {
    console.log(`(SES getEmailIdentity: status=${result.status} ${result.errorMessage ?? ""})`);
  }
  printDnsRecords(region, args.primaryDomain, args.sendingDomain, dkim);
  console.log(`\nnext: julkaise DNS-tietueet ja aja --verify kun SES näyttää DKIM Verified.`);
}

async function runVerify(db: Awaited<ReturnType<typeof createDb>>, companyId: string, regionArg?: string) {
  const [config] = await db
    .select()
    .from(companyEmailConfig)
    .where(eq(companyEmailConfig.companyId, companyId));
  if (!config) {
    console.error("company_email_config not found; run install first");
    process.exit(2);
  }
  if (config.mailProvider !== "ses") {
    console.error(`config provider is '${config.mailProvider}', not 'ses'`);
    process.exit(2);
  }
  const region = resolveRegion(regionArg);

  const result = await makeProvider(region).getDomainStatus(config.sendingDomain);
  if (!result.ok) {
    console.error(`ses error: status=${result.status} ${result.errorMessage ?? ""}`);
    process.exit(3);
  }
  if (result.domain.status !== "verified") {
    console.log(`identity status: ${result.domain.status} — ei vielä verifioitu:`);
    for (const r of result.domain.records) console.log(`  ${r.type.padEnd(5)} ${r.status} ${r.name}`);
    process.exit(1);
  }

  await db
    .update(companyEmailConfig)
    .set({ status: "verified", verifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(companyEmailConfig.companyId, companyId));
  console.log(`verified — sending sallittu (provider=ses)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
