/**
 * Writes schemas/creative-manifest.v1.schema.json from the zod schema in
 * src/creative-manifest/schema.ts (the single source). Node >= 24 loads the
 * .ts file through type stripping, so no build step is needed.
 *
 *   pnpm --filter @paperclipai/plugin-rk9-ads schema:generate
 *
 * tests/creative-manifest.spec.ts fails when the committed file is stale.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { creativeManifestJsonSchema } from "../src/creative-manifest/schema.ts";

const target = fileURLToPath(new URL("../schemas/creative-manifest.v1.schema.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(creativeManifestJsonSchema(), null, 2)}\n`);
console.log(`Wrote ${target}`);
