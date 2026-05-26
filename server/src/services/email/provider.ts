// Mail-provider abstraction.
//
// The outbound orchestrator (services/email/index.ts) and the domain-status
// scripts talk to a provider through the `MailProvider` interface instead of
// calling Resend directly. This lets a company run on a different provider by
// flipping `company_email_config.mail_provider` — the orchestration logic
// (suppression, rate limits, rendering, auditing) stays provider-neutral.
//
// Today only Resend is implemented; `ResendProvider` is a thin wrapper around
// the existing `resend-client.ts` HTTP calls (no behaviour change). The SES
// provider lands in SEC-105 (L2); `createMailProvider` already routes the
// `"ses"` case to a clear not-implemented error so a misconfigured company
// fails loudly rather than silently falling back to Resend.

import {
  sendViaResend,
  getDomainStatus,
  type ResendSendInput,
  type ResendSendResult,
  type ResendDomainResult,
} from "./resend-client.js";
import { SesProvider, sesConfigFromEnv, type SesProviderConfig } from "./ses-client.js";

// Provider-neutral send/domain shapes. They currently mirror Resend's wire
// shape; the SES provider will conform its results to these same types so
// callers never branch on the provider.
export type MailSendInput = ResendSendInput;
export type MailSendResult = ResendSendResult;
export type MailDomainResult = ResendDomainResult;

export interface MailProvider {
  /** Provider identifier, matches `company_email_config.mail_provider`. */
  readonly name: string;
  /** Send a fully-rendered message (html + text already built by the caller). */
  send(input: MailSendInput): Promise<MailSendResult>;
  /**
   * Fetch verification status for a domain. `domainRef` is the provider's
   * domain handle — for Resend that is `company_email_config.resend_domain_id`.
   */
  getDomainStatus(domainRef: string): Promise<MailDomainResult>;
}

/** Credentials resolved by the caller and handed to the provider factory. */
export interface MailProviderCredentials {
  /** Per-company Resend API key (from the `resend.api_key` secret). */
  resendApiKey?: string;
  /** Explicit SES config; when omitted the `"ses"` case reads it from the env. */
  ses?: SesProviderConfig;
}

class ResendProvider implements MailProvider {
  readonly name = "resend";
  constructor(private readonly apiKey: string) {}
  send(input: MailSendInput): Promise<MailSendResult> {
    return sendViaResend(this.apiKey, input);
  }
  getDomainStatus(domainRef: string): Promise<MailDomainResult> {
    return getDomainStatus(this.apiKey, domainRef);
  }
}

/**
 * Build the provider for a company. `providerName` is
 * `company_email_config.mail_provider` (defaults to `"resend"`).
 */
export function createMailProvider(
  providerName: string,
  creds: MailProviderCredentials,
): MailProvider {
  switch (providerName) {
    case "resend": {
      if (!creds.resendApiKey) {
        throw new Error("resend mail provider requires a resendApiKey");
      }
      return new ResendProvider(creds.resendApiKey);
    }
    case "ses":
      return new SesProvider(creds.ses ?? sesConfigFromEnv());
    default:
      throw new Error(`unknown mail provider: ${providerName}`);
  }
}
