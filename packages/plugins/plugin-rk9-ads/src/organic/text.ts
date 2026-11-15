/**
 * Text hygiene for organic posts (RK9-832, RK9-852). Pure: the card and the
 * service both use it, and the card shows the same cleaned string that the
 * publish sends to Meta.
 *
 * The cleaner keeps only what a reader can see (an allowlist, not a list of
 * known bad characters):
 * - Line breaks (CR LF, CR, NEL, U+2028, U+2029) become one line feed.
 * - Every other control (Cc), format character (Cf), default-ignorable code
 *   point and lone surrogate is removed, and so are U+FFFC, U+FFFD and U+1D159,
 *   which render as a box or nothing. The only exceptions are U+FE0F right
 *   after an emoji (at most one per emoji) and U+200D between two emoji.
 *   Variation selectors, tag characters, the Khmer and Mongolian invisible
 *   signs, the Hangul fillers and ZWJ runs therefore cannot carry hidden text.
 * - Every space separator (Zs) and the braille blank U+2800 become U+0020.
 *   Runs of spaces become one space, spaces at the start and end of a line go, and
 *   more than two line feeds in a row become two, so whitespace cannot carry
 *   a hidden message.
 * - A base character must be a letter, digit, punctuation, symbol, U+0020 or
 *   the line feed: private use, unassigned and noncharacter code points go.
 * - The text is normalised to NFC.
 * - A combining mark (Mn, Mc) stays only on a letter or digit of the same
 *   script, or when the mark itself is Inherited or Common, and at most two
 *   in a row. An enclosing mark (Me) is always removed.
 *
 * Limit: the card guarantees that the published text is, character for
 * character, the text on the card. It does not stop a message hidden in the
 * choice of visible characters (an emoji with or without U+FE0F or a ZWJ,
 * rare Inherited marks). RK9-860 tracks it.
 */

/** Scripts that have combining marks of their own (Unicode 16, checked against the runtime's regex tables). */
const MARK_SCRIPTS = [
  "Adlam", "Ahom", "Arabic", "Balinese", "Bamum", "Bassa_Vah", "Batak", "Bengali", "Bhaiksuki", "Brahmi", "Buginese", "Buhid",
  "Chakma", "Cham", "Coptic", "Cyrillic", "Devanagari", "Dives_Akuru", "Dogra", "Duployan", "Egyptian_Hieroglyphs", "Ethiopic",
  "Glagolitic", "Grantha", "Greek", "Gujarati", "Gunjala_Gondi", "Gurmukhi", "Han", "Hangul", "Hanifi_Rohingya", "Hanunoo",
  "Hebrew", "Javanese", "Kaithi", "Kannada", "Kawi", "Kayah_Li", "Kharoshthi", "Khitan_Small_Script", "Khmer", "Khojki",
  "Khudawadi", "Lao", "Lepcha", "Limbu", "Mahajani", "Makasar", "Malayalam", "Mandaic", "Manichaean", "Marchen",
  "Masaram_Gondi", "Meetei_Mayek", "Mende_Kikakui", "Miao", "Modi", "Mongolian", "Myanmar", "Nag_Mundari", "Nandinagari",
  "Newa", "Nko", "Nyiakeng_Puachue_Hmong", "Old_Permic", "Old_Uyghur", "Oriya", "Pahawh_Hmong", "Rejang", "Samaritan",
  "Saurashtra", "Sharada", "Siddham", "SignWriting", "Sinhala", "Sogdian", "Soyombo", "Sundanese", "Syloti_Nagri", "Syriac",
  "Tagalog", "Tagbanwa", "Tai_Tham", "Tai_Viet", "Takri", "Tamil", "Telugu", "Thaana", "Thai", "Tibetan", "Tifinagh",
  "Tirhuta", "Toto", "Wancho", "Yezidi", "Zanabazar_Square", "Garay", "Gurung_Khema", "Ol_Onal", "Tulu_Tigalari",
] as const;

/** One regex per script; a script name the runtime does not know is skipped (its marks are then removed). */
const SCRIPT_RES: ReadonlyArray<RegExp> = MARK_SCRIPTS.flatMap((name) => {
  try {
    return [new RegExp(`^\\p{Script=${name}}$`, "u")];
  } catch {
    return [];
  }
});

const LINE_BREAK_RE = /\r\n?|[\u0085\u2028\u2029]/g;
const LONE_SURROGATE_RE = /\p{Surrogate}/gu;
// Every space separator and the braille blank U+2800 (a visible-as-nothing space) become U+0020.
const SPACE_RE = /[\p{Zs}\u2800]/gu;
// Also removed: symbols and fillers that render as a blank or a box (object replacement U+FFFC, replacement character U+FFFD,
// musical null notehead U+1D159, Hangul fillers, Khitan filler U+16FE4).
const HIDDEN_RE = /^(?:[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]|[\ufffc\ufffd\u3164\u115f\u1160\uffa0\u{1D159}\u{16FE4}])$/u;
const EMOJI_RE = /^\p{Extended_Pictographic}$/u;
const SKIN_TONE_RE = /^\p{Emoji_Modifier}$/u;
// A visible base: a letter, digit, punctuation or symbol. Private use (Co), unassigned (Cn) and noncharacters are not.
const BASE_RE = /^[\p{L}\p{N}\p{P}\p{S}]$/u;
// A combining mark goes only on a letter or a digit.
const MARK_BASE_RE = /^[\p{L}\p{N}]$/u;
const MARK_RE = /^[\p{Mn}\p{Mc}]$/u;
const ENCLOSING_RE = /^\p{Me}$/u;
const SHARED_MARK_RE = /^[\p{Script=Inherited}\p{Script=Common}]$/u;
const ZWJ = "\u200d";
const VS16 = "\ufe0f";
/** Combining marks kept in a row on one base. */
const MAX_MARKS = 2;

function markFits(mark: string, base: string): boolean {
  if (SHARED_MARK_RE.test(mark)) return true;
  const script = SCRIPT_RES.find((re) => re.test(mark));
  return script !== undefined && script.test(base);
}

/** The allowlist pass over NFC text without line-break or space variants. */
function keepVisible(text: string): string {
  const points = Array.from(text);
  const out: string[] = [];
  let base: string | null = null;
  let marks = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const previous = out.at(-1);
    if (point === "\n") {
      out.push(point);
      base = null;
      marks = 0;
      continue;
    }
    if (point === VS16) {
      if (previous !== undefined && EMOJI_RE.test(previous)) out.push(point);
      continue;
    }
    if (point === ZWJ) {
      const afterEmoji = previous !== undefined && (EMOJI_RE.test(previous) || previous === VS16 || SKIN_TONE_RE.test(previous));
      const next = points[index + 1];
      if (afterEmoji && next !== undefined && EMOJI_RE.test(next) && BASE_RE.test(next)) out.push(point);
      continue;
    }
    if (HIDDEN_RE.test(point) || ENCLOSING_RE.test(point)) continue;
    if (MARK_RE.test(point)) {
      if (base !== null && marks < MAX_MARKS && markFits(point, base)) {
        out.push(point);
        marks += 1;
      }
      continue;
    }
    if (point !== " " && !BASE_RE.test(point)) continue;
    out.push(point);
    base = MARK_BASE_RE.test(point) ? point : null;
    marks = 0;
  }
  return out.join("");
}

/**
 * Normalises a caption with the allowlist above and trims it. The result is
 * a fixed point: cleaning it again changes nothing.
 */
export function cleanCaption(text: string): string {
  const normalised = text.replace(LINE_BREAK_RE, "\n").replace(LONE_SURROGATE_RE, "").normalize("NFC").replace(SPACE_RE, " ");
  return keepVisible(normalised)
    .replace(/ {2,}/g, " ")
    .replace(/ +$/gm, "")
    .replace(/^ +/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .normalize("NFC")
    .trim();
}

/**
 * Agent-supplied text on one line: cleaned like a caption, then every run of
 * whitespace (the line feed included) becomes one space.
 */
export function oneLineText(text: string): string {
  return cleanCaption(text).replace(/\s+/g, " ");
}
