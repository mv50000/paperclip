import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { getMessageByUnsubscribeToken, recordEvent } from "../services/outreach/index.js";

// RK9-194: public one-click unsubscribe (RFC 8058). No auth, no company
// scoping — a prospect who never signed in must be able to opt out with one
// click. Mirrors resend-inbound.ts/ses-inbound.ts: mounted directly on `app`
// (not under `/api`) so the path stays `/u/:token`, and it never leaks
// whether a token exists (always the same confirmation page).

const CONFIRMATION_HTML = `<!doctype html>
<html lang="fi"><head><meta charset="utf-8"><title>Peruutettu</title></head>
<body style="font-family: sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
<h1>Olet peruuttanut tilauksen</h1>
<p>Et saa enää viestejä tästä osoitteesta. Muutos on voimassa heti.</p>
</body></html>`;

async function handleUnsubscribe(db: Db, token: string): Promise<void> {
  const message = await getMessageByUnsubscribeToken(db, token);
  // An unknown/expired token still returns the confirmation page — a token
  // guesser learns nothing, and a double-click on an already-processed link
  // is not an error.
  if (!message) return;

  await recordEvent(db, message.companyId, {
    prospectId: message.prospectId,
    messageId: message.id,
    type: "unsubscribe",
    payload: { via: "one_click_link" },
  });
}

export function unsubscribeRoutes(db: Db) {
  const router = Router();

  async function respond(req: import("express").Request, res: import("express").Response) {
    const token = req.params.token as string;
    try {
      await handleUnsubscribe(db, token);
    } catch (err) {
      // Never surface an error to the prospect for a suppression request —
      // log it and still show the confirmation; a stuck token is triage, not
      // something to retry-loop a mail client over.
      logger.error({ err }, "unsubscribe handler failed");
    }
    res.status(200).type("html").send(CONFIRMATION_HTML);
  }

  // RFC 8058: mail clients doing one-click unsubscribe POST here with no
  // body (or `List-Unsubscribe=One-Click`, form-encoded); a human clicking
  // the link in a browser does a plain GET. Both suppress immediately.
  router.get("/u/:token", (req, res) => void respond(req, res));
  router.post("/u/:token", (req, res) => void respond(req, res));

  return router;
}
