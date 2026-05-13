// One-off: set github.repo_full_name = "mv50000/sunspot" for Sunspot company.
// Run: pnpm tsx scripts/update-sunspot-secret.ts
import { eq, and } from "drizzle-orm";
import { createDb, companies, companySecrets } from "@paperclipai/db";
import { secretService } from "../src/services/secrets.js";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set");
    process.exit(2);
  }
  const db = createDb(process.env.DATABASE_URL);
  const secrets = secretService(db);

  const companyId = "c405bf68-926e-445b-ba4b-aac40dad7ed7";
  const targetValue = "mv50000/sunspot";

  const [secret] = await db
    .select()
    .from(companySecrets)
    .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.name, "github.repo_full_name")));

  if (!secret) {
    console.error("Secret github.repo_full_name not found for Sunspot");
    process.exit(1);
  }

  console.log("Secret id:", secret.id, "current version:", secret.latestVersion);

  try {
    const current = await secrets.resolveSecretValue(companyId, secret.id, "latest");
    console.log("Current value:", current);
    if (current.trim() === targetValue) {
      console.log("Already correct, nothing to do.");
      return;
    }
  } catch (err) {
    console.warn("Could not resolve current value:", (err as Error).message);
  }

  const updated = await secrets.rotate(
    secret.id,
    { value: targetValue },
    { userId: "board" },
  );
  console.log("Rotated to version", updated.latestVersion, "→", targetValue);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
