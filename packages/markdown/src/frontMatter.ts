/**
 * YAML front matter recognition.
 *
 * Front matter is the `---`-delimited block a document may carry ahead of its
 * content. It is metadata, not content, and `marked` has no notion of it: the
 * opening `---` hits the stock thematic-break rule, and the keys that follow hit
 * the setext-heading rule because the closing `---` underlines them. Measured on
 * `---\ntitle: A\n---\n# Body`, marked emits `hr`, `heading("title: A")`,
 * `heading("Body")` — so an unstripped document paints a horizontal rule plus a
 * 28px bold heading made of its own metadata.
 *
 * Stripping it here, ahead of the lexer, keeps it out of the token stream
 * entirely rather than teaching every render arm to recognise and skip it.
 *
 * This is deliberately NOT a YAML parser. It finds the block's extent; what is
 * inside it is handed back as raw text. {@link parseFrontMatterFields} offers a
 * documented, narrow convenience over that text.
 */

/**
 * Opening delimiter: exactly `---` on the document's first line, with nothing
 * after it but optional trailing blanks.
 *
 * `----` is not an opener — it is a thematic break, and treating it as one keeps
 * `----\nkey: v\n----` rendering as it does today.
 */
const OPEN_RE = /^---[ \t]*\r?\n/;

/**
 * A strict prefix of {@link OPEN_RE} — text that has not yet revealed whether it
 * opens a front matter block. Only reachable mid-stream.
 */
const OPENER_PREFIX_RE = /^(?:-|--|---[ \t]*\r?)$/;

/**
 * A YAML mapping key: the shape the line after the opener must have for the
 * block to be front matter at all.
 *
 * This is the guard against swallowing a document that legitimately opens with a
 * thematic break. A `---` at the top of a document is followed by prose, a blank
 * line, or nothing; front matter is followed by a key. The value must be
 * separated by whitespace, as YAML requires, so `key:value` is prose.
 *
 * A leading `#` is excluded so `---\n# Title\n---` stays two thematic breaks
 * around a heading rather than becoming a block of YAML comment. That costs the
 * rare front matter whose first line is a comment, which then renders as
 * content — the pre-existing behaviour, not a new defect.
 */
const KEY_RE = /^[^\s:#][^:]*:(?:[ \t].*)?$/;

/** Closing delimiter: `---` or YAML's document terminator `...`, alone on a line. */
const CLOSE_RE = /^(?:---|\.\.\.)[ \t]*$/;

/**
 * How much text may be held while waiting for a closing delimiter.
 *
 * An opener with no closer yet holds back the entire document — nothing can be
 * lexed from inside a block that may turn out to be metadata — so the wait has
 * to be bounded. Real front matter is a few hundred bytes; past this much the
 * opener was a thematic break after all, and the text is released as content.
 */
const MAX_PENDING_CHARS = 4096;

/** Result of {@link scanFrontMatter}. */
export type FrontMatterScan =
  /** No front matter. The whole text is body. */
  | { readonly kind: 'none' }
  /**
   * The text so far may still open a front matter block whose closing delimiter
   * has not arrived. Nothing may be lexed yet. Only returned when `complete` is
   * `false`.
   */
  | { readonly kind: 'pending' }
  /** A complete block. `raw` is its contents; the body starts at `bodyStart`. */
  | {
      readonly kind: 'found';
      readonly raw: string;
      readonly bodyStart: number;
    };

const NONE: FrontMatterScan = { kind: 'none' };
const PENDING: FrontMatterScan = { kind: 'pending' };

/**
 * Locate a leading YAML front matter block.
 *
 * @param text  Document text, from its first character.
 * @param complete
 *   Whether `text` is the whole document. When `false` the text is a stream
 *   prefix and an undecidable case returns `'pending'`; when `true` there is
 *   nothing more coming, so an unterminated block is content — which is what
 *   marked would have produced all along.
 */
export function scanFrontMatter(text: string, complete: boolean): FrontMatterScan {
  // An empty document has no first character, so nothing about it is decided —
  // even when the caller calls it complete. This is load-bearing rather than an
  // edge case: it is what lets a stream seeded with `new Markdown('')` still
  // recognise front matter arriving in its first appended chunk.
  if (text.length === 0) return PENDING;

  const open = OPEN_RE.exec(text);
  if (!open) {
    return !complete && OPENER_PREFIX_RE.test(text) ? PENDING : NONE;
  }

  // Past the hold budget, stop waiting for more text and decide on what is in
  // hand — the opener was a thematic break after all. Folding the budget into
  // `complete` here rather than testing it at each `pending` return is what keeps
  // it from being bypassed by an early one.
  const decide = complete || text.length > MAX_PENDING_CHARS;

  const contentStart = open[0].length;
  let cursor = contentStart;
  let keyChecked = false;
  while (cursor < text.length) {
    const nl = text.indexOf('\n', cursor);
    // No verdict may be drawn from a PARTIAL line — one with no newline yet, so
    // the next chunk may extend it. `---\nti` is a chunk boundary inside
    // `title: A`: it fails the key test as written, and rejecting on it would
    // discard a legitimate block over where the network split the stream.
    // Symmetrically `---\nk: v\n---` may still grow a fourth dash, which is a
    // thematic break and not a closer. Waiting costs nothing visible, because a
    // candidate block renders nothing until it resolves either way.
    if (nl === -1 && !decide) return PENDING;
    const line = text.slice(cursor, nl === -1 ? text.length : nl).replace(/\r$/, '');
    if (!keyChecked) {
      if (!KEY_RE.test(line)) return NONE;
      keyChecked = true;
      // The closer is deliberately not tested against this line. `---\n---` is
      // two thematic breaks, not an empty front matter block, and the KEY_RE
      // test above is what rejects it.
    } else if (CLOSE_RE.test(line)) {
      return {
        kind: 'found',
        raw: text.slice(contentStart, cursor),
        // A closer with no trailing newline ends the document, so the body is
        // empty rather than starting one character past the end.
        bodyStart: nl === -1 ? text.length : nl + 1,
      };
    }
    if (nl === -1) break;
    cursor = nl + 1;
  }

  // Ran out of text inside the block with no closing delimiter.
  return decide ? NONE : PENDING;
}

/**
 * Read top-level scalar `key: value` pairs out of raw front matter text.
 *
 * A deliberately narrow convenience, not YAML. It handles the shape almost all
 * front matter actually uses and ignores everything else rather than guessing:
 *
 * - Only lines matching `key: value` at indent 0 are read. Indented lines are
 *   skipped, so a nested mapping's children and a `- ` sequence's items never
 *   leak out as top-level keys. The parent key itself is still present with an
 *   empty value — without parsing its children, `nest:` is indistinguishable
 *   from YAML's null scalar `empty:`.
 * - One matching pair of surrounding quotes is stripped from the value.
 * - `#` comment lines are skipped. A `#` inside a value is kept, because
 *   stripping it would corrupt colours and fragments.
 * - A repeated key keeps its last occurrence, as YAML does.
 *
 * Anything richer belongs to a real YAML parser applied to
 * {@link Markdown.frontMatter}.
 */
export function parseFrontMatterFields(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    // Indented lines belong to a structure this function does not model.
    if (line.length === 0 || /^[\s#]/.test(line)) continue;
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    const value = line.slice(sep + 1);
    // YAML requires whitespace after the key's colon; without it this is not a
    // mapping entry (`http://x` must not read as key `http`).
    if (value.length > 0 && value[0] !== ' ' && value[0] !== '\t') continue;
    out[line.slice(0, sep).trim()] = unquote(value.trim());
  }
  return out;
}

/** Strip one matching pair of surrounding quotes. */
function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  if ((first === '"' || first === "'") && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}
