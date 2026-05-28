// Shared DB opener for operator-run scripts in this directory.
//
// Two footguns this avoids (both bit the SES install scripts):
//   1. `createDb()` REQUIRES a url argument — calling it with none crashes at
//      runtime (`postgres(undefined)`). We resolve the url here.
//   2. Importing `@paperclipai/db` by its bare specifier does not resolve when a
//      script is run with `tsx scripts/<x>.ts`, because the workspace package is
//      not linked into the repo-root node_modules. Importing via the relative
//      path `../packages/db/src/index.js` resolves (its own deps load from
//      packages/db), which is the pattern the working scripts already use.
//
// Resolution order for the url mirrors scripts/backfill-issue-reference-mentions.ts:
//   DATABASE_URL env → loadConfig().databaseUrl → embedded-postgres default.

import { createDb, type Db } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";

export function resolveDatabaseUrl(): string {
  const config = loadConfig();
  return (
    process.env.DATABASE_URL?.trim() ||
    config.databaseUrl ||
    `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`
  );
}

/** Open a DB handle using the resolved connection url. */
export function openDb(): Db {
  return createDb(resolveDatabaseUrl());
}
