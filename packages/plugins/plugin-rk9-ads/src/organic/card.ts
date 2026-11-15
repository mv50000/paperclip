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
export const CAPTION_CHUNK_COLUMNS = 20;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// One column: printable ASCII, and the letters of Latin-1, Latin Extended-A/B and Latin Extended Additional.
const NARROW_RE = /^[ -~\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u024f\u1e00-\u1eff]$/u;
// Two columns: a letter or digit of a script whose glyphs a phone font keeps within two columns.
const LETTER_RE = /^[\p{L}\p{N}]$/u;
const BOUNDED_SCRIPT_RE =
  /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Armenian}\p{Script=Georgian}\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Thai}\p{Script=Lao}\p{Script=Tibetan}\p{Script=Myanmar}\p{Script=Khmer}\p{Script=Ethiopic}\p{Script=Cherokee}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]$/u;
// Letters drawn wider than two columns: Latin ligatures, number forms (U+2167 and the like), Arabic presentation ligatures, Cyrillic Extended-B (U+A66E).
const EXTRA_WIDE_LETTER_RE = /^[\ufb00-\ufb06\u2150-\u218f\ufb50-\ufdff\ua640-\ua69f]$/u;
// Two columns: emoji, skin tones, regional indicators and the common symbol blocks.
const BOUNDED_SYMBOL_RE =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\u00a0-\u00bf\u00d7\u00f7\u2010-\u2027\u2030-\u205e\u2070-\u209f\u20a0-\u20c0\u2190-\u23ff\u2460-\u27ff\u2800-\u28ff\u2900-\u2bff\u3000-\u303f\u3200-\u32ff\ufe30-\ufe4f\uff00-\uffef])$/u;
const MARK_RE = /^[\p{Mn}\p{Mc}]$/u;
// The widest Latin glyphs (W, M, @, %, the AE and OE ligatures) count two, with or without a diacritic.
const WIDE_LATIN_BASE_RE = /^[MWmw@%\u00c6\u00e6\u0152\u0153]/u;
const ZWJ = "\u200d";

/** A grapheme of more code points than the longest RGI emoji (10) fills a chunk alone. */
const MAX_GRAPHEME_CODE_POINTS = 10;

/**
 * Columns a phone font may give one grapheme. The estimate may only err wide
 * (RK9-852): a chunk that breaks too early costs a line, one that breaks too
 * late lets the rest of a chunk wrap onto an unquoted screen line. Summed
 * over the code points:
 * - 1 for printable ASCII and a Latin-1 or Latin Extended letter, 2 for the
 *   widest of them (W, M, @, %, AE, OE);
 * - 1 for each combining mark (Mn, Mc) that survived the cleaning;
 * - 0 for the ZWJ that joins two emoji (each emoji counts on its own);
 * - 2 for a letter or digit of a script listed above, an emoji, a skin tone,
 *   a regional indicator or a character of the common symbol blocks;
 * - anything else (an enclosing mark, a ligature, a space other than U+0020,
 *   a script not listed, a grapheme of more than 10 code points) fills a
 *   chunk alone.
 */
export function columns(grapheme: string): number {
  const points = Array.from(grapheme);
  if (points.length > MAX_GRAPHEME_CODE_POINTS) return CAPTION_CHUNK_COLUMNS;
  let width = 0;
  for (const point of points) {
    if (point === ZWJ) continue;
    if (NARROW_RE.test(point)) width += WIDE_LATIN_BASE_RE.test(point.normalize("NFD")) ? 2 : 1;
    else if (MARK_RE.test(point)) width += 1;
    else if (LETTER_RE.test(point) && BOUNDED_SCRIPT_RE.test(point) && !EXTRA_WIDE_LETTER_RE.test(point)) width += 2;
    else if (BOUNDED_SYMBOL_RE.test(point)) width += 2;
    else return CAPTION_CHUNK_COLUMNS;
  }
  return Math.min(Math.max(width, 1), CAPTION_CHUNK_COLUMNS);
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

/**
 * The media URL as the card shows it: the parser's normalised form, which has
 * no whitespace or control character, so a URL cannot open a card line.
 */
export function displayUrl(mediaUrl: string): string {
  try {
    const href = new URL(mediaUrl).href;
    // eslint-disable-next-line no-control-regex
    return /[\s\u0000-\u001f\u007f-\u009f]/.test(href) ? "(virheellinen osoite)" : href;
  } catch {
    return "(virheellinen osoite)";
  }
}

/** The line a card without the media itself starts with. */
export function posterNotice(mediaUrl: string): string {
  return `⚠️ Kuva on videon kansikuva, ei itse video. Katso video ennen hyväksyntää:\n🔗 ${displayUrl(mediaUrl)}`;
}

export function textCardNotice(mediaUrl: string): string {
  return `⚠️ Media ei näy kortissa. Katso se ennen hyväksyntää:\n🔗 ${displayUrl(mediaUrl)}`;
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
