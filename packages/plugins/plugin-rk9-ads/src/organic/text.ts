/**
 * Text hygiene for organic posts (RK9-832, RK9-852). Pure: the card and the
 * service both use it, so the card shows the text Meta gets.
 */

/**
 * Invisible format characters a caption must not carry: C0/C1 controls other
 * than the line feed (NEL U+0085 included), the Arabic letter mark U+061C, the
 * Mongolian vowel separator U+180E, zero-width spaces, LRM/RLM, bidi
 * embeddings, overrides and isolates, the word joiner and the invisible
 * operators U+2060-2064, the deprecated format controls U+206A-206F, the
 * interlinear annotation marks U+FFF9-FFFB, the BOM, and the invisible fillers
 * U+00AD, U+034F, U+115F, U+1160, U+3164 and U+FFA0. The braille blank U+2800
 * stays: Instagram captions use it for spacing, and the card quotes it.
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\u3164\ufeff\uffa0\ufff9-\ufffb]/g;

/**
 * Tag characters U+E0000-E007F. They are kept only inside the three
 * recommended subdivision flags (England, Scotland, Wales: U+1F3F4, the tag
 * letters gbeng, gbsct or gbwls, CANCEL TAG U+E007F); anywhere else they carry
 * text a reader cannot see.
 */
const TAG_RE =
  /(\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F})|[\u{E0000}-\u{E007F}]/gu;

/**
 * Normalises a caption: CR LF, CR and U+2028/2029 become line feeds, the
 * invisible characters above are dropped, and the result is trimmed. The
 * zero-width joiner U+200D stays: emoji sequences need it.
 */
export function cleanCaption(text: string): string {
  return text
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(INVISIBLE_RE, "")
    .replace(TAG_RE, (_match, flag: string | undefined) => flag ?? "")
    .trim();
}

/**
 * Agent-supplied text on one line: cleaned like a caption, then every run of
 * whitespace (the line feed and NEL included) becomes one space.
 */
export function oneLineText(text: string): string {
  return cleanCaption(text.replace(/[\s\u0085]+/g, " ")).replace(/\s+/g, " ");
}
