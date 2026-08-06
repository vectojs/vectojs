import type { Token, Tokens } from 'marked';

/**
 * Image predicates over a `marked` token tree.
 *
 * A pure leaf: nothing here touches the theme, an entity, or the renderer, so
 * it has no edge back into `Markdown.ts`. Kept together because these six
 * decide, between them, whether a paragraph renders as one `RichText` or as a
 * `Stack` of runs and images — a disagreement among them silently drops a
 * picture. See `forge/decisions/file-decomposition-2026-08.md`.
 */

/**
 * Whether a paragraph renders as a `Stack` of runs and images rather than one
 * `RichText`.
 *
 * The same test the `paragraph` render arm uses, so the reconciler and the
 * renderer cannot disagree about which shape a token produces.
 *
 * The search is over **descendants, not direct children**. `marked` nests an
 * image as deeply as the source does — `[![a](u)](dest)` is
 * `paragraph > link > image` and `- item ![a](u)` is
 * `list_item > text > [text, image]` — so a direct-children test failed every
 * nested form, sent the run to `inlineRunRichText`, which has no image support,
 * and dropped the image with no warning. Recursing costs one walk of an inline
 * run and removes the whole class rather than the two shapes that were reported.
 */
export function paragraphHasImage(token: Tokens.Paragraph): boolean {
  return containsImage(token.tokens);
}

/**
 * Whether any token in this inline run, at any depth, is an image.
 *
 * The one place the question is answered, so the predicate above, the list-item
 * tier check and the flattening the render arms do cannot drift apart.
 */
export function containsImage(tokens: Token[] | undefined): boolean {
  if (!tokens) return false;
  for (const token of tokens) {
    if (token.type === 'image') return true;
    if (containsImage((token as Tokens.Generic).tokens as Token[] | undefined)) return true;
  }
  return false;
}

/**
 * An inline run with nested images lifted to the top level, in source order.
 *
 * The paragraph arm splits a run into one `Stack` child per image plus one per
 * maximal run of non-image tokens, which requires every image to be a direct
 * member of the array it iterates. An image inside a link or an emphasis is not,
 * so the run is flattened first.
 *
 * A wrapper is replaced by its children rather than dropped, so the text inside a
 * link that also holds an image survives. Only wrappers **containing** an image
 * are opened: a plain link keeps its own token, and therefore keeps the styling
 * and click handling `renderInlineToRichText` gives it.
 */
/**
 * Every image in an inline run, at any depth, in source order.
 *
 * Pairs with `stripImages`: together they partition a run into the prose a
 * `RichText` can render and the images it cannot.
 */
export function imagesOf(tokens: Token[] | undefined): Tokens.Image[] {
  const images: Tokens.Image[] = [];
  for (const token of tokens ?? []) {
    if (token.type === 'image') {
      images.push(token as Tokens.Image);
      continue;
    }
    images.push(...imagesOf((token as Tokens.Generic).tokens as Token[] | undefined));
  }
  return images;
}

/**
 * The same token with every nested image removed, prose intact.
 *
 * A wrapper that held only an image is dropped; one that also held text keeps the
 * text. Used for a list item's lead run, which must show its marker and its prose
 * while its images render as blocks beneath.
 */
export function stripImages<T extends Token>(token: T): T {
  const children = (token as Tokens.Generic).tokens as Token[] | undefined;
  if (!children) return token;
  const kept: Token[] = [];
  for (const child of children) {
    if (child.type === 'image') continue;
    const grandchildren = (child as Tokens.Generic).tokens as Token[] | undefined;
    if (grandchildren && containsImage(grandchildren)) {
      const stripped = stripImages(child);
      const remaining = (stripped as Tokens.Generic).tokens as Token[] | undefined;
      if (remaining && remaining.length > 0) kept.push(stripped);
      continue;
    }
    kept.push(child);
  }
  return { ...token, tokens: kept };
}

export function liftNestedImages(tokens: Token[]): Token[] {
  const lifted: Token[] = [];
  for (const token of tokens) {
    if (token.type === 'image') {
      lifted.push(token);
      continue;
    }
    const children = (token as Tokens.Generic).tokens as Token[] | undefined;
    if (children && containsImage(children)) {
      lifted.push(...liftNestedImages(children));
      continue;
    }
    lifted.push(token);
  }
  return lifted;
}

/** Index of the last `image` token in an inline run, or -1 if there is none. */
export function lastIndexOfImage(tokens: Token[]): number {
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].type === 'image') return i;
  }
  return -1;
}

/**
 * How many `Stack` children the paragraph render arm builds for an inline run.
 *
 * One child per image, plus one per *maximal run* of consecutive non-image
 * tokens — the arm merges those into a single `RichText` via `flushText`, so this
 * is not `tokens.length`. Kept in lockstep with that arm; it is what
 * `updateImageParagraph` checks to confirm the entity it was handed is the one
 * built for the old tokens.
 */
export function expectedImageParagraphChildren(tokens: Token[]): number {
  let children = 0;
  let inTextRun = false;
  // Counted over the same flattened run the arm iterates, or a paragraph whose
  // image is nested would be checked against a child count it never built.
  for (const token of liftNestedImages(tokens)) {
    if (token.type === 'image') {
      children++;
      inTextRun = false;
    } else if (!inTextRun) {
      children++;
      inTextRun = true;
    }
  }
  return children;
}
