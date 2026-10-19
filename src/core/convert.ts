/**
 * adado — Arabic/Persian digit normalisation.
 *
 * Deliberately minimal: exactly two Unicode ranges change, everything else
 * (including Arabic punctuation such as U+066B ARABIC DECIMAL SEPARATOR)
 * passes through byte-for-byte. See README "What it does not do".
 */

/** U+0660..U+0669 ARABIC-INDIC DIGIT ZERO..NINE */
const ARABIC_INDIC_START = 0x0660;
/** U+06F0..U+06F9 EXTENDED ARABIC-INDIC (Persian) DIGIT ZERO..NINE */
const PERSIAN_START = 0x06f0;

const OFFSET = 0x30; // '0'

/**
 * Convert Arabic-Indic and Persian digits to ASCII digits.
 * All other code points are returned unchanged.
 */
export function toAsciiDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (cp >= ARABIC_INDIC_START && cp <= ARABIC_INDIC_START + 9) {
      out += String.fromCharCode(OFFSET + (cp - ARABIC_INDIC_START));
    } else if (cp >= PERSIAN_START && cp <= PERSIAN_START + 9) {
      out += String.fromCharCode(OFFSET + (cp - PERSIAN_START));
    } else {
      out += ch;
    }
  }
  return out;
}

/** True if the string contains at least one Arabic-Indic or Persian digit. */
export function hasArabicDigits(input: string): boolean {
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (
      (cp >= ARABIC_INDIC_START && cp <= ARABIC_INDIC_START + 9) ||
      (cp >= PERSIAN_START && cp <= PERSIAN_START + 9)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Prepare text for pasting back over a selection.
 *
 * Returns null when there is nothing to do, so callers can stay silent and
 * leave the selection and the undo stack untouched (see README "Why pressing
 * the hotkey on already-English text does nothing").
 */
export function preparePaste(raw: string): string | null {
  // Clipboards frequently end with a single line break that was never part of
  // the selection; pasting it back inserts a stray blank line.
  const hadTrailingNewline = /\r?\n$/.test(raw);
  const body = hadTrailingNewline ? raw.replace(/\r?\n$/, "") : raw;
  const converted = toAsciiDigits(body);
  if (converted === body) return null; // no digits changed -> do nothing
  return converted;
}