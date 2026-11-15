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
 * interlinear annotation marks U+FFF9-FFFB and the BOM.
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u180e\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g;

/**
 * Tag characters U+E0000-E007F. They are kept only inside a subdivision flag
 * emoji (U+1F3F4, tag letters or digits, CANCEL TAG U+E007F), such as the flag
 * of Wales; anywhere else they carry text a reader cannot see.
 */
const TAG_RE = /(\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,6}\u{E007F})|[\u{E0000}-\u{E007F}]/gu;

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
