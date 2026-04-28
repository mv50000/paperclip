// Idempotentti install-skripti Resend-integraatiolle.
//
// Käyttö:
//   pnpm tsx scripts/install-resend-skill.ts \
//     --company-id <uuid> \
//     --primary-domain ololla.fi \
//     --sending-domain ololla.fi \
//     --resend-domain-id <Resendin id> \
//     [--default-from-name "Aski"] \
//     [--max-per-agent-per-day 50] \
//     [--max-per-company-per-day 500]
//
//   pnpm tsx scripts/install-resend-skill.ts --company-id <uuid> --verify
//     - Pollaa Resendin domain-statuksen, flippaa company_email_config.status
//       arvoon 'verified' kun DKIM/SPF/DMARC ovat kaikki passattuja.
//
// Skripti EI kosketa company_secretsejä — secret tallennetaan
// erikseen (ks. doc/RESEND-SETUP.md kohta 2).

import { eq } from "drizzle-orm";
import { createDb, companyEmailConfig, companies } from "@paperclipai/db";
import { secretService } from "../server/src/services/secrets.js";
import { getDomainStatus } from "../server/src/services/email/resend-client.js";
import { seedDefaultTemplates } from "../server/src/services/email/template-seed.js";

interface Args {
  companyId: string;
  primaryDomain?: string;
  sendingDomain?: string;
  resendDomainId?: string;
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
      case "--company-id":
        out.companyId = next;
        i++;
        break;
      case "--primary-domain":
        out.primaryDomain = next;
        i++;
        break;
      case "--sending-domain":
        out.sendingDomain = next;
        i++;
        break;
      case "--resend-domain-id":
        out.resendDomainId = next;
        i++;
        break;
      case "--default-from-name":
        out.defaultFromName = next;
        i++;
        break;
      case "--max-per-agent-per-day":
        out.maxPerAgentPerDay = Number(next);
        i++;
        break;
      case "--max-per-company-per-day":
        out.maxPerCompanyPerDay = Number(next);
        i++;
        break;
      case "--verify":
        out.verify = true;
        break;
    }
  }
  if (!out.companyId) {
    throw new Error("--company-id required");
  }
  return out as Args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = await createDb();

  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, args.companyId));
  if (!company) {
    console.error(`company ${args.companyId} not found`);
    process.exit(2);
  }

  if (args.verify) {
    await runVerify(db, args.companyId);
    return;
  }

  if (!args.primaryDomain || !args.sendingDomain || !args.resendDomainId) {
    console.error(
      "first install requires --primary-domain, --sending-domain, --resend-domain-id",
    );
    process.exit(2);
  }

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
        resendDomainId: args.resendDomainId,
        defaultFromName: args.defaultFromName ?? existing.defaultFromName,
        maxPerAgentPerDay: args.maxPerAgentPerDay ?? existing.maxPerAgentPerDay,
        maxPerCompanyPerDay: args.maxPerCompanyPerDay ?? existing.maxPerCompanyPerDay,
        updatedAt: new Date(),
      })
      .where(eq(companyEmailConfig.companyId, args.companyId));
    console.log(`updated company_email_config for ${company.name} (status preserved)`);
  } else {
    await db.insert(companyEmailConfig).values({
      companyId: args.companyId,
      primaryDomain: args.primaryDomain,
      sendingDomain: args.sendingDomain,
      resendDomainId: args.resendDomainId,
      defaultFromName: args.defaultFromName,
      status: "pending",
      maxPerAgentPerDay: args.maxPerAgentPerDay ?? 50,
      maxPerCompanyPerDay: args.maxPerCompanyPerDay ?? 500,
    });
    console.log(`created company_email_config for ${company.name} (status=pending)`);
  }

  const seed = await seedDefaultTemplates(db, args.companyId);
  console.log(
    `templates: inserted=${seed.inserted.length} skipped=${seed.skipped.length} (idempotent)`,
  );

  console.log(
    `next: tallenna 'resend.api_key' ja 'resend.signing_secret' secretit ja aja --verify kun DNS valmis.`,
  );
}

async function runVerify(db: Awaited<ReturnType<typeof createDb>>, companyId: string) {
  const [config] = await db
    .select()
    .from(companyEmailConfig)
    .where(eq(companyEmailConfig.companyId, companyId));
  if (!config) {
    console.error("company_email_config not found; run install first");
    process.exit(2);
  }
  if (!config.resendDomainId) {
    console.error("resend_domain_id missing on config row");
    process.exit(2);
  }

  const secrets = secretService(db);
  const apiKeySecret = await secrets.getByName(companyId, "resend.api_key");
  if (!apiKeySecret) {
    console.error("resend.api_key secret not found; tallenna se ensin");
    process.exit(2);
  }
  const apiKey = await secrets.resolveSecretValue(companyId, apiKeySecret.id, "latest");

  const result = await getDomainStatus(apiKey, config.resendDomainId);
  if (!result.ok) {
    console.error(`resend api error: status=${result.status} ${result.errorMessage ?? ""}`);
    process.exit(3);
  }
  const allVerified = result.domain.records.every((r) => r.status === "verified");
  if (!allVerified) {
    console.log("DNS-tietueet eivät vielä kaikki verifioitu:");
    for (const r of result.domain.records) {
      console.log(`  ${r.type.padEnd(6)} ${r.status} ${r.name}`);
    }
    process.exit(1);
  }

  await db
    .update(companyEmailConfig)
    .set({ status: "verified", verifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(companyEmailConfig.companyId, companyId));
  console.log(`verified — sending sallittu`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
