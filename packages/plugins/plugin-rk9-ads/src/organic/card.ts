/**
 * The organic approval card (RK9-832). Pure: tests pin the text.
 *
 * The card shows what will be posted and where: the channel, the full
 * caption, the brand-lint result, the rules a person must check and the
 * deadline. The preview is the media itself (photo or video card). Telegram
 * caps a media caption at 1024 characters; a longer card goes out as a text
 * message with the media link, so the approver always sees the whole caption.
 */

import { CAPTION_MAX_CHARS, TEXT_MAX_CHARS, type CardMedia } from "../kit/telegram/bot-api.js";
import { localDate, localTime } from "../kit/local-time.js";
import { CHANNEL_LABELS, type OrganicChannel, type OrganicLint, type OrganicMode } from "./types.js";

/** Room kept under the caption limit for the status lines a decision appends. */
const STATUS_ROOM = 120;
const MAX_LISTED = 8;

export interface OrganicCardFacts {
  brandCode: string;
  channel: OrganicChannel;
  mode: OrganicMode;
  caption: string;
  lint: OrganicLint | null;
  validUntil: Date;
  timeZone: string;
  creativeId: string;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function lintLines(lint: OrganicLint | null): string[] {
  if (!lint) return ["⚠️ brand-lint: ei tulosta. Tarkista kaikki säännöt itse."];
  const s = lint.summary;
  const lines = [`🔎 brand-lint: läpi (${s.pass} pass, ${s.partial} partial, ${s.skip} skip)`];
  if (lint.needsHumanReview) {
    const partial = lint.results.filter((row) => row.status === "partial").map((row) => row.id);
    lines.push(`⚠️ NEEDS HUMAN REVIEW: kone ei lukenut kaikkea (${partial.slice(0, MAX_LISTED).join(", ") || "partial"})`);
  }
  const human = lint.results.filter((row) => row.status === "human");
  if (human.length > 0) {
    lines.push("Tarkista itse:");
    lines.push(...human.slice(0, MAX_LISTED).map((row) => `☐ ${clip(row.rule || row.id, 120)}`));
    if (human.length > MAX_LISTED) lines.push(`… ja ${human.length - MAX_LISTED} muuta`);
  }
  return lines;
}

export function organicCardText(facts: OrganicCardFacts): string {
  const lines = [`📣 Orgaaninen julkaisu odottaa hyväksyntää (${facts.brandCode})`, `Kanava: ${CHANNEL_LABELS[facts.channel]}`];
  if (facts.mode === "dry_run") lines.push("🧪 Kuivaharjoitus: hyväksyntä ei julkaise mitään Metaan.");
  lines.push("", facts.caption.length > 0 ? facts.caption : "(ei tekstiä)", "");
  lines.push(...lintLines(facts.lint));
  lines.push("", `Creative ${facts.creativeId}`);
  lines.push(`Voimassa ${localDate(facts.validUntil, facts.timeZone)} klo ${localTime(facts.validUntil, facts.timeZone)} asti. Ei muistutuksia.`);
  return lines.join("\n");
}

/**
 * Card candidates, best first: the media with the whole text as its caption
 * (when it fits), the poster of a video, then a text card with the media link.
 * A text that does not fit even a text message is refused by the caller.
 */
export function organicCardCandidates(
  text: string,
  media: { kind: "video" | "image"; mediaUrl: string; posterUrl: string | null },
): Array<{ media: CardMedia; mediaUrl: string | null; text: string }> {
  const out: Array<{ media: CardMedia; mediaUrl: string | null; text: string }> = [];
  if (text.length <= CAPTION_MAX_CHARS - STATUS_ROOM) {
    out.push({ media: media.kind === "video" ? "video" : "photo", mediaUrl: media.mediaUrl, text });
    if (media.kind === "video" && media.posterUrl) out.push({ media: "photo", mediaUrl: media.posterUrl, text });
  }
  out.push({ media: "text", mediaUrl: null, text: `Esikatselu: ${media.mediaUrl}\n\n${text}` });
  return out;
}

export function fitsTextCard(text: string, mediaUrl: string): boolean {
  return `Esikatselu: ${mediaUrl}\n\n${text}`.length <= TEXT_MAX_CHARS - STATUS_ROOM;
}
