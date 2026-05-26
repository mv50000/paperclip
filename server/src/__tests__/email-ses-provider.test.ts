import { describe, expect, it, vi } from "vitest";
import { SendEmailCommand, GetEmailIdentityCommand } from "@aws-sdk/client-sesv2";
import { SesProvider, sesConfigFromEnv, type SesSendClient } from "../services/email/ses-client.js";

function fakeClient(impl: (cmd: unknown) => Promise<unknown>): SesSendClient {
  return { send: vi.fn(impl) } as unknown as SesSendClient;
}

const input = {
  from: "Tuki <tuki@sunspot.fi>",
  to: ["asiakas@example.com"],
  cc: ["cc@example.com"],
  subject: "Käsitelty",
  html: "<p>Hei</p>",
  text: "Hei",
};

describe("SesProvider.send", () => {
  it("sends Raw content and returns the MessageId", async () => {
    const client = fakeClient(async () => ({ MessageId: "ses-msg-1" }));
    const provider = new SesProvider({ region: "eu-west-1", client });

    const res = await provider.send(input);

    expect(res).toEqual({ ok: true, providerMessageId: "ses-msg-1" });
    const cmd = (client.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as SendEmailCommand;
    expect(cmd).toBeInstanceOf(SendEmailCommand);
    expect(cmd.input.FromEmailAddress).toBe("Tuki <tuki@sunspot.fi>");
    expect(cmd.input.Destination?.ToAddresses).toEqual(["asiakas@example.com"]);
    expect(cmd.input.Destination?.CcAddresses).toEqual(["cc@example.com"]);
    expect(cmd.input.Content?.Raw?.Data).toBeInstanceOf(Uint8Array);
  });

  it("fails clearly when SES returns no MessageId", async () => {
    const provider = new SesProvider({ region: "eu-west-1", client: fakeClient(async () => ({})) });
    const res = await provider.send(input);
    expect(res).toEqual({
      ok: false,
      status: 502,
      errorCode: "no_message_id",
      errorMessage: "SES returned no MessageId",
    });
  });

  it("maps a thrown SES error onto a provider_error result", async () => {
    const provider = new SesProvider({
      region: "eu-west-1",
      client: fakeClient(async () => {
        throw Object.assign(new Error("Email address is not verified"), {
          name: "MessageRejected",
          $metadata: { httpStatusCode: 400 },
        });
      }),
    });
    const res = await provider.send(input);
    expect(res).toEqual({
      ok: false,
      status: 400,
      errorCode: "MessageRejected",
      errorMessage: "Email address is not verified",
    });
  });
});

describe("SesProvider.getDomainStatus", () => {
  it("reports verified and builds DKIM CNAME records", async () => {
    const client = fakeClient(async () => ({
      VerifiedForSendingStatus: true,
      DkimAttributes: { Status: "SUCCESS", Tokens: ["tok1", "tok2", "tok3"] },
    }));
    const provider = new SesProvider({ region: "eu-west-1", client });

    const res = await provider.getDomainStatus("sunspot.fi");

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.domain.id).toBe("sunspot.fi");
    expect(res.domain.status).toBe("verified");
    expect(res.domain.records).toHaveLength(3);
    expect(res.domain.records[0]).toEqual({
      type: "CNAME",
      name: "tok1._domainkey.sunspot.fi",
      value: "tok1.dkim.amazonses.com",
      status: "verified",
    });
    const cmd = (client.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as GetEmailIdentityCommand;
    expect(cmd).toBeInstanceOf(GetEmailIdentityCommand);
    expect(cmd.input.EmailIdentity).toBe("sunspot.fi");
  });

  it("reports pending while DKIM is not yet successful", async () => {
    const provider = new SesProvider({
      region: "eu-west-1",
      client: fakeClient(async () => ({
        VerifiedForSendingStatus: false,
        DkimAttributes: { Status: "PENDING", Tokens: ["tok1"] },
      })),
    });
    const res = await provider.getDomainStatus("sunspot.fi");
    if (!res.ok) throw new Error("expected ok");
    expect(res.domain.status).toBe("pending");
    expect(res.domain.records[0].status).toBe("pending");
  });

  it("reports failed when DKIM verification failed", async () => {
    const provider = new SesProvider({
      region: "eu-west-1",
      client: fakeClient(async () => ({ VerifiedForSendingStatus: false, DkimAttributes: { Status: "FAILED" } })),
    });
    const res = await provider.getDomainStatus("sunspot.fi");
    if (!res.ok) throw new Error("expected ok");
    expect(res.domain.status).toBe("failed");
  });
});

describe("sesConfigFromEnv", () => {
  it("throws without a region", () => {
    expect(() => sesConfigFromEnv({})).toThrow(/SES_REGION/);
  });

  it("reads region and keys from the environment", () => {
    const cfg = sesConfigFromEnv({
      SES_REGION: "eu-west-1",
      AWS_ACCESS_KEY_ID: "AKIA_TEST",
      AWS_SECRET_ACCESS_KEY: "secret",
    });
    expect(cfg).toMatchObject({ region: "eu-west-1", accessKeyId: "AKIA_TEST", secretAccessKey: "secret" });
  });
});
