// Amazon SES provider — implements the MailProvider interface (SEC-105/L2).
//
// Outbound goes through SESv2 SendEmail with Raw content (MIME built in
// mime.ts) so we keep full header control (List-Unsubscribe, threading) and a
// path to attachments later. getDomainStatus maps SES's identity/DKIM
// verification onto the provider-neutral MailDomainResult so the install/verify
// tooling (SEC-107/L3) can poll it the same way it polls Resend.
//
// Credentials come from one shared RK9 AWS account (env / IAM role), not from
// per-company secrets — the per-company difference is the domain identity, not
// the key. `sesConfigFromEnv` resolves region + optional explicit keys.

import {
  SESv2Client,
  SendEmailCommand,
  GetEmailIdentityCommand,
} from "@aws-sdk/client-sesv2";
import type { MailProvider, MailSendInput, MailSendResult, MailDomainResult } from "./provider.js";
import { buildRawMime } from "./mime.js";

/** The slice of SESv2Client we use; narrowed so tests can inject a fake. */
export type SesSendClient = Pick<SESv2Client, "send">;

export interface SesProviderConfig {
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Injected client for tests; production builds a real SESv2Client. */
  client?: SesSendClient;
}

/**
 * Resolve SES config from the environment. Region is required (SES_REGION, then
 * AWS_REGION / AWS_DEFAULT_REGION). Explicit keys are optional — when omitted the
 * AWS SDK default credential chain (env vars, IAM role) is used.
 */
export function sesConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SesProviderConfig {
  const region = env.SES_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  if (!region) {
    throw new Error("ses mail provider requires SES_REGION (or AWS_REGION) in the environment");
  }
  return {
    region,
    accessKeyId: env.SES_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.SES_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY,
  };
}

export class SesProvider implements MailProvider {
  readonly name = "ses";
  private readonly client: SesSendClient;

  constructor(cfg: SesProviderConfig) {
    this.client =
      cfg.client ??
      new SESv2Client({
        region: cfg.region,
        ...(cfg.accessKeyId && cfg.secretAccessKey
          ? { credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } }
          : {}),
      });
  }

  async send(input: MailSendInput): Promise<MailSendResult> {
    const command = new SendEmailCommand({
      FromEmailAddress: input.from,
      Destination: { ToAddresses: input.to, CcAddresses: input.cc },
      Content: { Raw: { Data: buildRawMime(input) } },
    });
    try {
      const res = await this.client.send(command);
      const id = res.MessageId;
      if (!id) {
        return { ok: false, status: 502, errorCode: "no_message_id", errorMessage: "SES returned no MessageId" };
      }
      return { ok: true, providerMessageId: id };
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number }; message?: string };
      return {
        ok: false,
        status: e.$metadata?.httpStatusCode ?? 502,
        errorCode: e.name ?? null,
        errorMessage: e.message ?? null,
      };
    }
  }

  async getDomainStatus(domainRef: string): Promise<MailDomainResult> {
    const command = new GetEmailIdentityCommand({ EmailIdentity: domainRef });
    try {
      const res = await this.client.send(command);
      const dkim = res.DkimAttributes ?? {};
      const dkimOk = dkim.Status === "SUCCESS";
      const dkimFailed = dkim.Status === "FAILED";
      const status: "pending" | "verified" | "failed" =
        res.VerifiedForSendingStatus && dkimOk ? "verified" : dkimFailed ? "failed" : "pending";
      const records = (dkim.Tokens ?? []).map((token) => ({
        type: "CNAME",
        name: `${token}._domainkey.${domainRef}`,
        value: `${token}.dkim.amazonses.com`,
        status: (dkimOk ? "verified" : "pending") as "verified" | "pending",
      }));
      return { ok: true, domain: { id: domainRef, status, records } };
    } catch (err) {
      const e = err as { $metadata?: { httpStatusCode?: number }; message?: string };
      return { ok: false, status: e.$metadata?.httpStatusCode ?? 500, errorMessage: e.message ?? null };
    }
  }
}
