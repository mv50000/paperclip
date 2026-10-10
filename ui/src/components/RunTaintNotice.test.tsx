// @vitest-environment node
// RK9 Custom (RK9-319): the run view shows the server-side taint mark.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunTaintNotice } from "./RunTaintNotice";

describe("RunTaintNotice", () => {
  it("names each taint source with its references", () => {
    const html = renderToStaticMarkup(
      <RunTaintNotice
        taint={{
          taintedAt: "2026-10-10T08:00:00.000Z",
          sources: [
            {
              kind: "email_inbound_wake",
              at: "2026-10-10T08:00:00.000Z",
              issueId: "11111111-2222-4333-8444-555555555555",
            },
            {
              kind: "email_body_read",
              at: "2026-10-10T08:01:00.000Z",
              messageId: "99999999-2222-4333-8444-555555555555",
            },
          ],
        }}
      />,
    );

    expect(html).toContain('data-testid="run-taint-notice"');
    expect(html).toContain("Untrusted content");
    expect(html).toContain("Woken by an inbound email");
    expect(html).toContain("Read an inbound email body");
    expect(html).toContain('data-taint-kind="email_body_read"');
    expect(html).toContain("issue 11111111");
    expect(html).toContain("email 99999999");
  });
});
