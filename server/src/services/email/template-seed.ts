// Idempotent seed of default email templates per company. Re-running this
// does not overwrite a customised template (we only insert when the
// `(company_id, key, locale)` UNIQUE constraint allows it).

import type { Db } from "@paperclipai/db";
import { emailTemplates } from "@paperclipai/db";
import { DEFAULT_AUTO_REPLY_TEMPLATES, type DefaultTemplate } from "./default-templates.js";

export interface SeedReport {
  inserted: Array<{ key: string; locale: string }>;
  skipped: Array<{ key: string; locale: string }>;
}

export async function seedDefaultTemplates(
  db: Db,
  companyId: string,
  templates: DefaultTemplate[] = DEFAULT_AUTO_REPLY_TEMPLATES,
): Promise<SeedReport> {
  const inserted: Array<{ key: string; locale: string }> = [];
  const skipped: Array<{ key: string; locale: string }> = [];

  for (const tpl of templates) {
    const result = await db
      .insert(emailTemplates)
      .values({
        companyId,
        key: tpl.key,
        locale: tpl.locale,
        subjectTpl: tpl.subjectTpl,
        bodyMdTpl: tpl.bodyMdTpl,
      })
      .onConflictDoNothing({
        target: [emailTemplates.companyId, emailTemplates.key, emailTemplates.locale],
      })
      .returning({ id: emailTemplates.id });
    if (result.length > 0) {
      inserted.push({ key: tpl.key, locale: tpl.locale });
    } else {
      skipped.push({ key: tpl.key, locale: tpl.locale });
    }
  }

  return { inserted, skipped };
}
