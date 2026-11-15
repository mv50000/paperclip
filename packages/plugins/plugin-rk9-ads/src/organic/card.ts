/**
 * The organic approval card (RK9-832). Pure: tests pin the text.
 *
 * The card shows what will be posted and where: the channel, the full
 * caption, the brand-lint result, the rules a person must check and the
 * deadline. The preview is the media itself (photo or video card). Telegram
 * caps a media caption at 1024 characters; a longer card goes out as a text
 * message with the media link, so the approver always sees the whole caption.
 * When the card cannot show the media itself (a video falls back to its
 * poster or to a text card), the card says so and links the media.
 */

import { CAPTION_MAX_CHARS, TEXT_MAX_CHARS, type CardMedia } from "../kit/telegram/bot-api.js";
import { localDate, localTime } from "../kit/local-time.js";
import { oneLineText } from "./text.js";
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
  /** Lines about the media lock (a dry run's weak lock, for example). */
  warnings?: string[];
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Agent-supplied rule text on one line, so it cannot open a line of its own.
 * It is cleaned like a caption (bidi controls, NEL and other invisible
 * characters go) before it is clipped.
 */
function oneLine(text: string, max: number): string {
  return clip(oneLineText(text), max);
}

/** Agent-supplied text as card lines: `first` opens the first chunk, "┆ " each continuation. */
function quoted(first: string, text: string): string[] {
  return chunkLine(text).map((chunk, index) => `${index === 0 ? first : CAPTION_CONTINUE}${chunk}`);
}

export function lintLines(lint: OrganicLint | null): string[] {
  if (!lint) return ["⚠️ brand-lint: ei tulosta. Tarkista kaikki säännöt itse."];
  const s = lint.summary;
  const lines = [`🔎 brand-lint: läpi (${s.pass} pass, ${s.partial} partial, ${s.skip} skip)`];
  if (lint.needsHumanReview) {
    const partial = lint.results.filter((row) => row.status === "partial").map((row) => oneLine(row.id, 40));
    lines.push("⚠️ NEEDS HUMAN REVIEW: kone ei lukenut kaikkea:");
    lines.push(...quoted(CAPTION_CONTINUE, partial.slice(0, MAX_LISTED).join(", ") || "partial"));
  }
  const human = lint.results.filter((row) => row.status === "human");
  if (human.length > 0) {
    lines.push("Tarkista itse:");
    lines.push(...human.slice(0, MAX_LISTED).flatMap((row) => quoted("☐ ", oneLine(row.rule || row.id, 120))));
    if (human.length > MAX_LISTED) lines.push(`… ja ${human.length - MAX_LISTED} muuta`);
  }
  return lines;
}

/** The mode line. It comes before the caption, so no caption line can stand in for it. */
export function modeLine(mode: OrganicMode): string {
  return mode === "dry_run" ? "Tila: 🧪 Kuivaharjoitus: hyväksyntä ei julkaise mitään Metaan." : "Tila: 🔴 LIVE: hyväksyntä julkaisee Metaan.";
}

/** Every caption line starts with "│ ", so a caption cannot look like a line of the card. */
export const CAPTION_QUOTE = "│ ";
/** A caption line too long for one phone line goes on in chunks that start with "┆ ". */
export const CAPTION_CONTINUE = "┆ ";
/**
 * Display columns per quoted chunk. Telegram wraps a long line on a phone
 * without the quote mark, so a long caption line could show a forged card line
 * at the start of a screen line (RK9-852). A chunk this short fits one line of
 * a narrow phone screen at the default font size.
 */
export const CAPTION_CHUNK_COLUMNS = 26;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Emoji and East Asian wide characters take two columns.
const WIDE_RE = /\p{Extended_Pictographic}|[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{20000}-\u{3fffd}]/u;

function columns(grapheme: string): number {
  return WIDE_RE.test(grapheme) ? 2 : 1;
}

/**
 * Splits one caption line into chunks of at most `width` columns. A chunk
 * ends after the last space that fits when there is one in its second half;
 * otherwise it breaks between graphemes. No text is lost or reordered.
 */
export function chunkLine(line: string, width = CAPTION_CHUNK_COLUMNS): string[] {
  const parts = Array.from(graphemes.segment(line), (segment) => segment.segment);
  const chunks: string[] = [];
  let start = 0;
  while (start < parts.length) {
    let used = 0;
    let end = start;
    let lastSpace = -1;
    while (end < parts.length && used + columns(parts[end]!) <= width) {
      used += columns(parts[end]!);
      if (/^\s$/u.test(parts[end]!)) lastSpace = end;
      end += 1;
    }
    if (end === start) end = start + 1;
    if (end < parts.length && lastSpace >= start + Math.floor((end - start) / 2)) end = lastSpace + 1;
    chunks.push(parts.slice(start, end).join(""));
    start = end;
  }
  return chunks.length > 0 ? chunks : [""];
}

/** The caption as card lines: "│ " opens each caption line, "┆ " each continuation. */
export function captionLines(caption: string): string[] {
  const lines = caption.length > 0 ? caption.split("\n") : ["(ei tekstiä)"];
  return lines.flatMap((line) => chunkLine(line).map((chunk, index) => `${index === 0 ? CAPTION_QUOTE : CAPTION_CONTINUE}${chunk}`));
}

export function organicCardText(facts: OrganicCardFacts): string {
  const lines = [`📣 Orgaaninen julkaisu odottaa hyväksyntää (${facts.brandCode})`, `Kanava: ${CHANNEL_LABELS[facts.channel]}`, modeLine(facts.mode)];
  lines.push(...(facts.warnings ?? []).flatMap((warning) => quoted("⚠️ ", oneLine(warning, 200))));
  lines.push(...lintLines(facts.lint));
  lines.push("", `Creative ${facts.creativeId}`);
  lines.push(`Voimassa ${localDate(facts.validUntil, facts.timeZone)} klo ${localTime(facts.validUntil, facts.timeZone)} asti. Ei muistutuksia.`);
  lines.push("", "Julkaistava teksti:");
  lines.push(...captionLines(facts.caption));
  return lines.join("\n");
}

/** The line a card without the media itself starts with. */
export function posterNotice(mediaUrl: string): string {
  return `⚠️ Kuva on videon kansikuva, ei itse video. Katso video ennen hyväksyntää:\n🔗 ${mediaUrl}`;
}

export function textCardNotice(mediaUrl: string): string {
  return `⚠️ Media ei näy kortissa. Katso se ennen hyväksyntää:\n🔗 ${mediaUrl}`;
}

/**
 * Card candidates, best first: the media with the whole text as its caption
 * (when it fits), the poster of a video, then a text card with the media link.
 * The poster and text cards say that the media is not on the card. A text
 * that does not fit even a text message is refused by the caller.
 */
export function organicCardCandidates(
  text: string,
  media: { kind: "video" | "image"; mediaUrl: string; posterUrl: string | null },
): Array<{ media: CardMedia; mediaUrl: string | null; text: string }> {
  const out: Array<{ media: CardMedia; mediaUrl: string | null; text: string }> = [];
  if (text.length <= CAPTION_MAX_CHARS - STATUS_ROOM) {
    out.push({ media: media.kind === "video" ? "video" : "photo", mediaUrl: media.mediaUrl, text });
  }
  const posterText = `${posterNotice(media.mediaUrl)}\n\n${text}`;
  if (media.kind === "video" && media.posterUrl && posterText.length <= CAPTION_MAX_CHARS - STATUS_ROOM) {
    out.push({ media: "photo", mediaUrl: media.posterUrl, text: posterText });
  }
  out.push({ media: "text", mediaUrl: null, text: `${textCardNotice(media.mediaUrl)}\n\n${text}` });
  return out;
}

export function fitsTextCard(text: string, mediaUrl: string): boolean {
  return `${textCardNotice(mediaUrl)}\n\n${text}`.length <= TEXT_MAX_CHARS - STATUS_ROOM;
}
