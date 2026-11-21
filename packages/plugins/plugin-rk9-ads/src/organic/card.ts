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
const STATUS_ROOM = 170;
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
  /** True when the post asks for Instagram's "AI info" label (RK9-954). */
  aiGenerated?: boolean;
}

/** Clips to `max` graphemes, so no surrogate pair or emoji sequence is cut in half. */
function clip(text: string, max: number): string {
  const parts = Array.from(graphemes.segment(text), (segment) => segment.segment);
  return parts.length <= max ? text : `${parts.slice(0, max - 1).join("")}…`;
}

/**
 * Agent-supplied rule text on one line, so it cannot open a line of its own.
 * It is cleaned like a caption (bidi controls, NEL and other invisible
 * characters go) before it is clipped.
 */
function oneLine(text: string, max: number): string {
  return clip(oneLineText(text), max);
}

/** Agent-supplied text as card lines: `first` opens the first chunk, "┆ " or "↳ " each continuation. */
function quoted(first: string, text: string): string[] {
  return chunkSegments(text).map((chunk) => `${chunk.join === "first" ? first : continuePrefix(chunk.join)}${chunk.text}`);
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

/**
 * The card line of a post that asks for Instagram's "AI info" label (RK9-954).
 * The plugin's own fixed text, before the caption like the mode line; a
 * caption line that copies it is still quoted.
 */
export const AI_LABEL_LINE = "AI-merkintä: kyllä (Instagramin AI info)";

/** Every caption line starts with "│ ", so a caption cannot look like a line of the card. */
export const CAPTION_QUOTE = "│ ";
/** A caption line too long for one phone line goes on in chunks: "┆ " after a space (the space is not shown), */
export const CAPTION_CONTINUE = "┆ ";
/** and "↳ " when the break falls inside a word, so a space at the break is never invisible (RK9-852). */
export const CAPTION_WORD_CONTINUE = "\u21b3 ";
/** The card line that explains the two continuation marks; the card shows it when a chunk continues. */
export const CAPTION_LEGEND = "(┆ = jatkuu välilyönnin jälkeen, \u21b3 = jatkuu samaa sanaa)";
/**
 * Display columns per quoted chunk. Telegram wraps a long line on a phone
 * without the quote mark, so a long caption line could show a forged card line
 * at the start of a screen line (RK9-852). A chunk this short fits one line of
 * a narrow phone screen at the default font size.
 */
export const CAPTION_CHUNK_COLUMNS = 20;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// One column: printable ASCII, the Latin-1 letters, and the Finnish, Swedish, Estonian and German letters outside Latin-1 (S/Z with caron, capital sharp s).
const NARROW_RE = /^[ -~\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u00ff\u0160\u0161\u017d\u017e\u1e9e]$/u;
// The widest of them (W, M, @, %, AE) count two.
const WIDE_NARROW_RE = /^[MWmw@%\u00c6\u00e6]/u;
// Two columns: a letter or digit of a script whose glyphs a phone font keeps within two columns.
const LETTER_RE = /^[\p{L}\p{N}]$/u;
const BOUNDED_SCRIPT_RE =
  /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Armenian}\p{Script=Georgian}\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Thai}\p{Script=Lao}\p{Script=Tibetan}\p{Script=Myanmar}\p{Script=Khmer}\p{Script=Ethiopic}\p{Script=Cherokee}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]$/u;
// Code points known to be drawn wider than two columns, checked before every other rule: Latin digraphs and ligatures (U+01C4-01CC, U+01F1-01F3, U+0132/0133, U+1EFA-1EFF, U+FB00-FB06), number forms (U+2167), Arabic presentation ligatures (U+FDFD), Cyrillic Extended-B (U+A66E), and the widest Tamil and Malayalam letters, numbers and vowel signs (U+0B94, U+0BF0-0BFA, U+0D14, U+0D4C, U+0D57).
const EXTRA_WIDE_RE = /^[\u0132\u0133\u01c4-\u01cc\u01f1-\u01f3\u1efa-\u1eff\ufb00-\ufb06\u2150-\u218f\ufb50-\ufdff\ua640-\ua69f\u0b94\u0bf0-\u0bfa\u0d14\u0d4c\u0d57]$/u;
// Two columns: emoji, skin tones, regional indicators, and a short list of common symbols (Latin-1 symbols, dashes, quotes, bullets and the ellipsis, primes, currency, the trade mark sign, a few math signs, short arrows, circled digits and letters, box drawing, blocks, geometric shapes, miscellaneous symbols and dingbats, braille, CJK punctuation and enclosed CJK, fullwidth forms). Long arrows, brackets spanning several lines and every other symbol fill a chunk alone.
const BOUNDED_SYMBOL_RE =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\u00a1-\u00bf\u00d7\u00f7\u2010-\u2027\u2030\u2032-\u2037\u2039\u203a\u20a0-\u20c0\u2122\u2190-\u2199\u2212\u2213\u221e\u2248\u2260\u2264\u2265\u2460-\u2473\u24b6-\u24e9\u2500-\u27bf\u2801-\u28ff\u3001-\u303f\u3200-\u32ff\uff01-\uff60\uffe0-\uffe6])$/u;
// Never counted: private use, unassigned and surrogate code points fill a chunk alone.
const UNASSIGNED_RE = /^[\p{Co}\p{Cn}\p{Cs}]$/u;
const NONSPACING_MARK_RE = /^\p{Mn}$/u;
const SPACING_MARK_RE = /^\p{Mc}$/u;
const ZWJ = "\u200d";

/** A grapheme of more code points than the longest RGI emoji (10) fills a chunk alone. */
const MAX_GRAPHEME_CODE_POINTS = 10;

/**
 * Columns a phone font may give one grapheme. The estimate overestimates the
 * known cases (RK9-852): a chunk that breaks too early costs a line, one that
 * breaks too late lets the rest of a chunk wrap onto an unquoted screen line.
 * Summed over the code points:
 * - a private-use or unassigned code point, or one known to be drawn wider
 *   (a digraph or ligature, the widest Tamil and Malayalam letters and vowel
 *   signs), fills a chunk alone before any other rule applies;
 * - 1 for printable ASCII, a Latin-1 letter and the Finnish, Swedish,
 *   Estonian and German letters (2 for W, M, @, % and AE);
 * - 1 for each nonspacing mark (Mn), 2 for each spacing mark (Mc);
 * - 0 for the ZWJ that joins two emoji (each emoji counts on its own);
 * - 2 for any other Latin letter, a letter or digit of a script listed above,
 *   an emoji, a skin tone, a regional indicator or a listed symbol;
 * - anything else (an enclosing mark, a long arrow, a space other than
 *   U+0020, an unlisted symbol or script such as U+2103, U+2109 or U+2116, a
 *   grapheme of more than 10 code points) fills a chunk alone.
 */
export function columns(grapheme: string): number {
  const points = Array.from(grapheme);
  if (points.length > MAX_GRAPHEME_CODE_POINTS) return CAPTION_CHUNK_COLUMNS;
  let width = 0;
  for (const point of points) {
    if (point === ZWJ) continue;
    if (UNASSIGNED_RE.test(point) || EXTRA_WIDE_RE.test(point)) return CAPTION_CHUNK_COLUMNS;
    if (NARROW_RE.test(point)) width += WIDE_NARROW_RE.test(point) ? 2 : 1;
    else if (NONSPACING_MARK_RE.test(point)) width += 1;
    else if (SPACING_MARK_RE.test(point)) width += 2;
    else if (LETTER_RE.test(point) && BOUNDED_SCRIPT_RE.test(point)) width += 2;
    else if (BOUNDED_SYMBOL_RE.test(point)) width += 2;
    else return CAPTION_CHUNK_COLUMNS;
  }
  return Math.min(Math.max(width, 1), CAPTION_CHUNK_COLUMNS);
}

/** How a chunk joins the chunk before it. */
export type ChunkJoin = "first" | "space" | "word";

export interface Chunk {
  text: string;
  join: ChunkJoin;
}

/**
 * Splits one cleaned line (no space at either end, no space runs: the output
 * of `cleanCaption` or `oneLineText`) into chunks of at most `width` columns.
 * No chunk starts or ends with a space (RK9-852): a break at a space consumes
 * that one space and the next chunk joins with "space"; a break inside a word
 * joins with "word". The card marks the two joins with different prefixes, so
 * two captions that differ by one space never give the same card. A chunk
 * ends after the last space that fits when there is one in its second half;
 * otherwise it breaks between graphemes.
 */
export function chunkSegments(line: string, width = CAPTION_CHUNK_COLUMNS): Chunk[] {
  // Every space is a part of its own: a prepended mark (U+0D4E, U+11A3A) would otherwise join the space after it into one grapheme.
  const parts = line.split(" ").flatMap((word, index) => {
    const segments = Array.from(graphemes.segment(word), (segment) => segment.segment);
    return index === 0 ? segments : [" ", ...segments];
  });
  const chunks: Chunk[] = [];
  let start = 0;
  let join: ChunkJoin = "first";
  while (start < parts.length) {
    let used = 0;
    let end = start;
    let lastSpace = -1;
    while (end < parts.length && used + columns(parts[end]!) <= width) {
      used += columns(parts[end]!);
      if (parts[end] === " ") lastSpace = end;
      end += 1;
    }
    if (end === start) end = start + 1;
    let chunkEnd = end;
    let next = end;
    let nextJoin: ChunkJoin = "word";
    if (end < parts.length && parts[end] === " ") {
      next = end + 1;
      nextJoin = "space";
    } else if (end < parts.length && lastSpace > start && lastSpace >= start + Math.floor((end - start) / 2)) {
      chunkEnd = lastSpace;
      next = lastSpace + 1;
      nextJoin = "space";
    }
    chunks.push({ text: parts.slice(start, chunkEnd).join(""), join });
    start = next;
    join = nextJoin;
  }
  return chunks.length > 0 ? chunks : [{ text: "", join: "first" }];
}

/** The chunk texts of one line (see `chunkSegments`). */
export function chunkLine(line: string, width = CAPTION_CHUNK_COLUMNS): string[] {
  return chunkSegments(line, width).map((chunk) => chunk.text);
}

/** The card prefix of a continuation chunk. */
function continuePrefix(join: ChunkJoin): string {
  return join === "word" ? CAPTION_WORD_CONTINUE : CAPTION_CONTINUE;
}

/** The card line for an empty caption: the plugin's own text without the caption quote, so no caption can look like it. */
export const CAPTION_EMPTY = "(ei teksti\u00e4)";

/** The caption as card lines: "\u2502 " opens each caption line, "\u2506 " a chunk after a space, "\u21b3 " a chunk inside a word. */
export function captionLines(caption: string): string[] {
  if (caption.length === 0) return [CAPTION_EMPTY];
  const lines = caption.split("\n");
  return lines.flatMap((line) => chunkSegments(line).map((chunk) => `${chunk.join === "first" ? CAPTION_QUOTE : continuePrefix(chunk.join)}${chunk.text}`));
}

/**
 * Reads card caption lines back into the caption: the inverse of
 * `captionLines`. "\u2506 " puts the consumed space back, "\u21b3 " joins without one.
 * A line may have lost its trailing spaces (Telegram trims), so "\u2502" alone is
 * an empty caption line. Returns null for a line without a caption prefix.
 */
export function unwrapCaptionLines(lines: readonly string[]): string | null {
  if (lines.length === 1 && lines[0] === CAPTION_EMPTY) return "";
  const out: string[] = [];
  for (const line of lines) {
    if (line === CAPTION_QUOTE.trimEnd() || line.startsWith(CAPTION_QUOTE)) out.push(line.slice(CAPTION_QUOTE.length));
    else if (line.startsWith(CAPTION_CONTINUE) && out.length > 0) out[out.length - 1] += ` ${line.slice(CAPTION_CONTINUE.length)}`;
    else if (line.startsWith(CAPTION_WORD_CONTINUE) && out.length > 0) out[out.length - 1] += line.slice(CAPTION_WORD_CONTINUE.length);
    else return null;
  }
  return out.join("\n");
}

export function organicCardText(facts: OrganicCardFacts): string {
  const lines = [`📣 Orgaaninen julkaisu odottaa hyväksyntää (${facts.brandCode})`, `Kanava: ${CHANNEL_LABELS[facts.channel]}`, modeLine(facts.mode)];
  if (facts.aiGenerated === true) lines.push(AI_LABEL_LINE);
  lines.push(...(facts.warnings ?? []).flatMap((warning) => quoted("⚠️ ", oneLine(warning, 200))));
  lines.push(...lintLines(facts.lint));
  lines.push("", `Creative ${facts.creativeId}`);
  lines.push(`Voimassa ${localDate(facts.validUntil, facts.timeZone)} klo ${localTime(facts.validUntil, facts.timeZone)} asti. Ei muistutuksia.`);
  const caption = captionLines(facts.caption);
  const continued = [...lines, ...caption].some((line) => line.startsWith(CAPTION_CONTINUE) || line.startsWith(CAPTION_WORD_CONTINUE));
  lines.push("");
  if (continued) lines.push(CAPTION_LEGEND);
  lines.push("Julkaistava teksti:");
  lines.push(...caption);
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
