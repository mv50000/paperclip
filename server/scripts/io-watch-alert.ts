// Posts a single Slack message to the #all-rk9 channel using the Paperclip
// Slack client (bot token + secrets decrypted from the DB, same mechanism as
// check-github-webhook-health.ts). Driven by io-watch.sh, which detects
// nvme0n1 IO-pressure edges and calls this with a pre-formatted message.
//
// Usage:
//   pnpm tsx scripts/io-watch-alert.ts "<message text>"
//
// Environment (inherited from the systemd unit, same as the webhook monitor):
//   DATABASE_URL, PAPERCLIP_SECRETS_MASTER_KEY_FILE
//
// Exits 0 on posted, 1 on a recoverable problem (company/channel/token missing),
// 2 on argument/db error.

import { eq } from "drizzle-orm";
import { createDb, companies } from "@paperclipai/db";
import { createSlackClientService } from "../src/services/slack/client.js";

const ALERT_COMPANY_NAME = "SelfEvolvingClaudeCo"; // RK9 holding (Slack bot token holder)
const CHANNEL = process.env.IO_WATCH_SLACK_CHANNEL ?? "#all-rk9";

async function main() {
  const text = process.argv[2];
  if (!text) {
    console.error("usage: io-watch-alert.ts <message text>");
    process.exit(2);
  }
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL env var required");
    process.exit(2);
  }
  const db = createDb(dbUrl);
  const [target] = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.name, ALERT_COMPANY_NAME));
  if (!target) {
    console.error(`alert company ${ALERT_COMPANY_NAME} not found — not posted`);
    process.exit(1);
  }
  const slack = createSlackClientService(db);
  const result = await slack.postMessage(target.id, { channel: CHANNEL, text });
  if (result.ok) {
    console.log(`posted to ${CHANNEL} ts=${result.ts}`);
    process.exit(0);
  }
  console.error(`Slack post failed: ${result.reason}`);
  process.exit(1);
}

main().catch((err) => {
  console.error("io-watch-alert error:", err);
  process.exit(2);
});
