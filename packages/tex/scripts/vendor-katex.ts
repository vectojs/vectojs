/**
 * Vendors KaTeX's parse + layout kernel into `src/kernel/`, stripping the two
 * output layers VectoJS does not use: MathML and DOM node emission.
 *
 * This exists as a script rather than a one-off manual copy because the standing
 * cost named in `vectojs-docs/forge/decisions/math-engine-2026-08.md` is tracking
 * KaTeX upstream for security and version updates. A codemod makes re-vendoring a
 * re-run; a hand-edited copy across 44 files makes it an archaeology exercise.
 *
 * What it removes, and why each is safe:
 *
 * - **MathML.** `defineFunction` stores `mathmlBuilder` into
 *   `_mathmlGroupBuilders`, which only `buildMathML` reads. We never call it, but
 *   the builders are values inside object literals passed to a function, so no
 *   bundler can prove them dead — the bytes ship unless they are deleted from
 *   source. This is the single largest removable mass in the kernel.
 * - **`toNode()`.** Emits real DOM (`document.createElement`). Zero-DOM forbids
 *   it, and it cannot run in a worker at all.
 * - **`toMarkup()`.** Emits HTML strings. Our emit layer owns serialization, and
 *   two serializers over one tree is how they drift apart.
 *
 * Layout is deliberately untouched. `Span` already carries `height`/`depth`/
 * `style`/`children` and `makeVList` positions children by explicit coordinate,
 * so the emit layer translates a span tree — it does not re-derive layout.
 *
 * ## Why a token scanner rather than the TypeScript AST
 *
 * TypeScript 7 is the Go port, and it does **not** expose `createSourceFile`.
 * `import ts from 'typescript'` yields only `{version, versionMajorMinor}`; the
 * AST moved to `typescript/unstable/ast`, which ships a scanner and node
 * predicates but no standalone parser — parsing goes through a `Project`/
 * `Program` API that wants a tsconfig and on-disk state, which is the wrong shape
 * for a codemod that runs on files it is about to write. So this walks tokens and
 * matches braces, which is sufficient: every construct being removed is
 * introduced by the identifier `mathmlBuilder`, `toNode` or `toMarkup` at a known
 * nesting depth, and the scanner already handles the cases a regex gets wrong
 * (the identifier inside a string, a comment, or a template literal).
 *
 * Usage:
 *   bun run scripts/vendor-katex.ts [--source <path-to-katex-checkout>] [--check]
 *
 * `--check` re-runs the transform into a temp dir and diffs it against the
 * committed tree, so CI or a reviewer can confirm `src/kernel/` is exactly what
 * this script produces from the recorded upstream commit.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createScanner, SyntaxKind } from 'typescript/unstable/ast';
import {
  CLASS_TO_FACE,
  DEFAULT_FONT,
  DELIM_SIZE_FONTS,
  DIRECT_FONT_CLASSES,
  SIZE_MULTIPLIERS,
} from '../src/emit/fonts';
import { MU, NULL_DELIMITER_SPACE, ROW_ALIGN_CLASSES } from '../src/emit/svg';

/**
 * Files copied from KaTeX's `src/`, ordered as the pipeline runs rather than
 * alphabetically so the shape of what we depend on stays legible.
 */
const KEEP_FILES = [
  // Lex, expand macros, parse.
  'Lexer.ts',
  'Token.ts',
  'SourceLocation.ts',
  'MacroExpander.ts',
  'macros.ts',
  'defineMacro.ts',
  'Namespace.ts',
  'Parser.ts',
  'parseNode.ts',
  'parseTree.ts',
  'ParseError.ts',
  'Settings.ts',

  // Typesetting state: the style cascade, the size cascade, font selection.
  'Style.ts',
  'Options.ts',
  'units.ts',
  'utils.ts',

  // Symbol and metric tables. `fontMetricsData.js` is the 2077-line metrics
  // table that spacing fidelity depends on consuming exactly.
  'symbols.ts',
  'atoms.ts',
  'fontMetrics.ts',
  'fontMetricsData.js',
  'fontMetricsData.d.ts',
  'spacingData.ts',
  'wide-character.ts',
  'unicodeScripts.ts',
  'unicodeSupOrSub.ts',
  'unicodeSymbols.js',
  'unicodeAccents.js',

  // Layout: the box model, the atom-spacing pass, stretchy glyph assembly.
  'tree.ts',
  'domTree.ts',
  'buildCommon.ts',
  'buildHTML.ts',
  'delimiter.ts',
  'stretchy.ts',
  'svgGeometry.ts',

  // Function/environment registries and the 46 builders.
  'environments.ts',
  'functions.ts',
];

/**
 * Files deliberately **not** vendored, and hand-written in `src/registry/`
 * instead.
 *
 * `defineFunction.ts` and `defineEnvironment.ts` are the only two files where
 * `mathmlBuilder` appears in *expression* position rather than as an object
 * property: they destructure it, test it, and assign it into
 * `_mathmlGroupBuilders`. Deleting an identifier out of `if (mathmlBuilder) {` or
 * `_mathmlGroupBuilders[type] = mathmlBuilder;` leaves `if () {` — syntactically
 * broken code that a token-level transform cannot repair, because repairing it
 * means understanding the control flow it sits in.
 *
 * They are also the kernel's two extension points and total ~330 lines, so owning
 * them outright costs little and removes the one place a codemod would have to
 * rewrite logic rather than delete declarations. Each hand-written file names the
 * upstream original it replaces so the pair can be re-diffed on a version bump.
 */
const HAND_WRITTEN = ['defineFunction.ts', 'defineEnvironment.ts'];

/** Directories copied wholesale. */
const KEEP_DIRS = ['functions', 'environments', 'types'];

/**
 * Files whose `toNode`/`toMarkup` methods are stripped. Only these two define
 * them; the rest of the kernel called them, never after this transform.
 */
const DOM_EMIT_FILES = new Set(['domTree.ts', 'tree.ts']);

/**
 * Top-level declarations that exist only to serve MathML output.
 *
 * These are removed with their whole statement. `mathmlBuilder` is the registered
 * builder itself; the rest are MathML-only helpers that upstream keeps beside the
 * HTML ones in the same file, so dropping the imports without dropping these
 * leaves code referencing modules that are no longer vendored.
 *
 * Each was found by re-running the transform and grepping the output for surviving
 * MathML references — not by reading upstream and guessing.
 */
const MATHML_DECLARATIONS = new Set([
  'mathmlBuilder',
  // `stretchy.ts` exports HTML and MathML stretchy builders side by side; only
  // `stretchySvg` is reachable from the span tree.
  'stretchyMathML',
  // `arrow.ts` / `tag.ts` MathML-only node helpers.
  'paddedNode',
  'pad',
  // `tree.ts`: `toText()` is documented upstream as applying to "MathDomNode's
  // only" and its guard `isMathDomNode` narrows to a MathML type. Both are
  // unreachable once MathML is gone, and leaving them behind is not merely dead
  // code — it fails to compile, because `MathDomNode` is a MathML type whose
  // import has been pruned. Measured: keeping them was 4 of the kernel's type
  // errors (2x TS2304 unresolved `MathDomNode`, 2x TS2339 on `toText` and
  // `constructor`).
  'toText',
  'isMathDomNode',
]);

/** Identifiers belonging to the MathML layer, dropped from mixed imports. */
const MATHML_NAMES = new Set([
  'mml',
  'MathNode',
  'TextNode',
  'SpaceNode',
  'MathDomNode',
  'MathNodeType',
  'MathMLBuilder',
  'newDocumentFragment',
  // Removed as a declaration above, so every import of it must go too — four
  // function files import it beside the `stretchySvg` they legitimately use.
  'stretchyMathML',
]);

interface Edit {
  start: number;
  end: number;
}

interface Tok {
  kind: number;
  text: string;
  start: number;
  end: number;
  /** Offset including any leading trivia — comments and whitespace. */
  fullStart: number;
}

interface FileStats {
  path: string;
  linesBefore: number;
  linesAfter: number;
  bytesBefore: number;
  bytesAfter: number;
  mathmlRemoved: number;
  domEmitRemoved: number;
}

/**
 * Token kinds after which a `/` begins a regular expression rather than a
 * division. JavaScript cannot decide this lexically, so the scanner defaults to
 * division and the caller must ask for a re-scan.
 *
 * The set is "anything that cannot end an expression": after a value —
 * identifier, literal, `)`, `]` — a slash is division; everywhere else it opens a
 * regex. Getting this wrong is not a subtle mis-tokenization: `.replace(/##/g,
 * "")` in `MacroExpander.ts:424` makes the TS7 scanner stop advancing and emit
 * empty tokens forever, so the whole codemod hangs rather than failing.
 */
function regexAllowedAfter(kind: number | undefined): boolean {
  if (kind === undefined) return true;
  return !(
    kind === SyntaxKind.Identifier ||
    kind === SyntaxKind.StringLiteral ||
    kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === SyntaxKind.RegularExpressionLiteral ||
    kind === SyntaxKind.NumericLiteral ||
    kind === SyntaxKind.BigIntLiteral ||
    kind === SyntaxKind.CloseParenToken ||
    kind === SyntaxKind.CloseBracketToken ||
    kind === SyntaxKind.CloseBraceToken ||
    kind === SyntaxKind.PlusPlusToken ||
    kind === SyntaxKind.MinusMinusToken ||
    kind === SyntaxKind.ThisKeyword ||
    kind === SyntaxKind.SuperKeyword ||
    kind === SyntaxKind.TrueKeyword ||
    kind === SyntaxKind.FalseKeyword ||
    kind === SyntaxKind.NullKeyword
  );
}

/**
 * Tokenizes a source file, keeping both real and full (trivia-inclusive) starts.
 *
 * Two constructs need an explicit re-scan, because JavaScript cannot be tokenized
 * without grammatical context — and both failed *silently* rather than loudly
 * when first missed:
 *
 * - **Regex literals.** The scanner reports `/` as division. Left unrescanned,
 *   `.replace(/##/g, "")` (`MacroExpander.ts:424`) makes it stop advancing and
 *   emit empty tokens forever, hanging the codemod.
 * - **Template literals.** After a `${…}` substitution the scanner must be told
 *   that `}` resumes a template. Left unrescanned the `}` reads as a plain brace
 *   and *the entire rest of the file* is consumed as one template token — in
 *   `domTree.ts` that swallowed lines 457-641, hiding six `toNode`/`toMarkup`
 *   definitions on `SvgNode`, `PathNode` and `LineNode`. The transform still
 *   reported success; it had quietly done two thirds of the job.
 *
 * Template depth is a stack rather than a counter because a substitution may
 * contain an object literal or a nested template, so `}` continues a template
 * only when the innermost open construct is a substitution.
 */
function tokenize(text: string): Tok[] {
  const scanner = createScanner({ languageVersion: 99, skipTrivia: true });
  scanner.setText(text);
  const tokens: Tok[] = [];
  let previous: number | undefined;

  // One entry per enclosing construct: `true` for a template substitution,
  // `false` for an ordinary brace.
  const braces: boolean[] = [];

  for (;;) {
    let kind = scanner.scan();
    if (kind === SyntaxKind.EndOfFile) break;

    if (
      (kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) &&
      regexAllowedAfter(previous)
    ) {
      kind = scanner.reScanSlashToken();
    }

    if (kind === SyntaxKind.CloseBraceToken && braces[braces.length - 1] === true) {
      braces.pop();
      kind = scanner.reScanTemplateToken(false);
      // A middle (`} … ${`) reopens a substitution; a tail closes the template.
      if (kind === SyntaxKind.TemplateMiddle) braces.push(true);
    } else if (kind === SyntaxKind.OpenBraceToken) {
      braces.push(false);
    } else if (kind === SyntaxKind.CloseBraceToken) {
      braces.pop();
    } else if (kind === SyntaxKind.TemplateHead) {
      braces.push(true);
    }

    tokens.push({
      kind,
      text: scanner.getTokenText(),
      start: scanner.getTokenStart(),
      end: scanner.getTokenEnd(),
      fullStart: scanner.getTokenFullStart(),
    });
    previous = kind;
  }
  return tokens;
}

/**
 * Applies deletions right-to-left so earlier offsets stay valid.
 *
 * Deliberately text-range based rather than re-printing an AST: re-printing would
 * reformat all 19k vendored lines and drop every upstream comment, making the
 * next `git diff` against a new KaTeX release unreadable. This keeps the tree
 * byte-identical to upstream except at the cut sites.
 */
function applyEdits(text: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    // Guard against overlapping ranges, which would corrupt the output silently.
    if (edit.end > lastStart) continue;
    out = out.slice(0, edit.start) + out.slice(edit.end);
    lastStart = edit.start;
  }
  return out;
}

/**
 * Grows a deletion range to swallow a trailing comma and the whole line when
 * nothing but whitespace surrounds it, so removing `  mathmlBuilder,` does not
 * leave a blank indented line behind.
 */
function expandToFullLines(text: string, start: number, end: number): Edit {
  let lineStart = start;
  while (lineStart > 0 && text[lineStart - 1] !== '\n') lineStart--;
  const prefixIsBlank = text.slice(lineStart, start).trim() === '';

  let after = end;
  while (after < text.length && (text[after] === ' ' || text[after] === '\t')) after++;
  if (text[after] === ',') {
    after++;
    while (after < text.length && (text[after] === ' ' || text[after] === '\t')) after++;
  }
  const suffixIsBlank = after >= text.length || text[after] === '\n' || text[after] === '\r';

  if (prefixIsBlank && suffixIsBlank) {
    let lineEnd = after;
    if (text[lineEnd] === '\r') lineEnd++;
    if (text[lineEnd] === '\n') lineEnd++;
    return { start: lineStart, end: lineEnd };
  }
  return { start, end: after };
}

const OPENERS = new Set<number>([
  SyntaxKind.OpenBraceToken,
  SyntaxKind.OpenParenToken,
  SyntaxKind.OpenBracketToken,
]);
const CLOSERS = new Set<number>([
  SyntaxKind.CloseBraceToken,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
]);

/**
 * Finds the end of the value that starts at `i`, stopping at the comma or closing
 * brace that terminates it at the same bracket depth.
 *
 * This is what makes a token walk sufficient in place of a parser: a property
 * value — arrow function, method body, call, identifier — always ends at a
 * depth-zero `,` or `}`, and the scanner has already resolved strings, comments
 * and template literals into single tokens, so none of their contents can be
 * mistaken for a delimiter.
 */
function endOfValue(tokens: Tok[], i: number): number {
  let depth = 0;
  for (let j = i; j < tokens.length; j++) {
    const kind = tokens[j].kind;
    if (OPENERS.has(kind)) depth++;
    else if (CLOSERS.has(kind)) {
      if (depth === 0) return j - 1;
      depth--;
    } else if (depth === 0 && kind === SyntaxKind.CommaToken) {
      return j - 1;
    }
  }
  return tokens.length - 1;
}

/**
 * Finds the end of a declaration beginning at `i`.
 *
 * Handles both statement shapes upstream uses, which do not end the same way:
 * `const mathmlBuilder = (…) => {…};` terminates on a depth-zero `;`, while
 * `function mathmlBuilder(…) {…}` terminates on the closing `}` of its body with
 * no semicolon at all. Looking only for `;` on a function declaration runs to the
 * next unrelated statement and deletes it too.
 */
function endOfDeclaration(tokens: Tok[], i: number): number {
  let depth = 0;
  let sawBody = false;
  for (let j = i; j < tokens.length; j++) {
    const kind = tokens[j].kind;
    if (OPENERS.has(kind)) {
      depth++;
      if (kind === SyntaxKind.OpenBraceToken) sawBody = true;
    } else if (CLOSERS.has(kind)) {
      depth--;
      // A brace-bodied declaration ends here, unless a `;` follows immediately
      // (the `const … = function(){};` form), which the next branch consumes.
      if (depth === 0 && sawBody && kind === SyntaxKind.CloseBraceToken) {
        const next = tokens[j + 1];
        return next && next.kind === SyntaxKind.SemicolonToken ? j + 1 : j;
      }
    } else if (depth === 0 && kind === SyntaxKind.SemicolonToken) {
      return j;
    }
  }
  return tokens.length - 1;
}

/**
 * True when `tokens[i]` sits inside an `implements` or `extends` clause.
 *
 * Scans backwards over the identifier/comma run that makes up the clause's type
 * list and stops at anything else, so it cannot wander into an unrelated
 * statement.
 */
function inHeritageClause(tokens: Tok[], i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    const kind = tokens[j].kind;
    if (kind === SyntaxKind.ImplementsKeyword || kind === SyntaxKind.ExtendsKeyword) {
      return true;
    }
    if (kind !== SyntaxKind.CommaToken && kind !== SyntaxKind.Identifier) {
      return false;
    }
  }
  return false;
}

/**
 * True when `tokens[i]` is a class or interface *member declaration* rather than
 * a call or a property access.
 *
 * The distinction is the whole safety of the method strip. A member declaration
 * sits at the start of a statement — the previous significant token closes the
 * previous member (`}` or `;`) or opens the body (`{`) — whereas a call site is
 * preceded by `.`, `=`, `(`, `?`, `return` and so on. Anything not clearly a
 * declaration is left alone, because a false negative leaves dead code while a
 * false positive corrupts a live expression.
 */
function isMemberDeclaration(tokens: Tok[], i: number): boolean {
  if (tokens[i + 1]?.kind !== SyntaxKind.OpenParenToken) return false;
  const prev = tokens[i - 1];
  if (!prev) return false;
  return (
    prev.kind === SyntaxKind.CloseBraceToken ||
    prev.kind === SyntaxKind.SemicolonToken ||
    prev.kind === SyntaxKind.OpenBraceToken
  );
}

/**
 * Returns the index of the token closing a class method's body, or `i` when the
 * member is a bodiless signature.
 *
 * Shared by the MathML and DOM-emit strips so there is one implementation of
 * "walk to the end of this member". Requiring a `{` before the terminating `}`
 * is what keeps the walk from running off the token list on an interface
 * signature such as `toNode(): Node;`, which has no body at all.
 */
function endOfMethod(tokens: Tok[], i: number): number {
  let depth = 0;
  let sawBody = false;
  for (let j = i + 1; j < tokens.length; j++) {
    const kind = tokens[j].kind;
    if (kind === SyntaxKind.SemicolonToken && depth === 0 && !sawBody) {
      return j;
    }
    if (OPENERS.has(kind)) {
      depth++;
      if (kind === SyntaxKind.OpenBraceToken) sawBody = true;
    } else if (CLOSERS.has(kind)) {
      depth--;
      if (depth === 0 && sawBody) {
        return j;
      }
    }
  }
  return i;
}

/**
 * Collects the ranges to delete from one source file.
 *
 * Returns counts alongside the edits so the caller can report what was actually
 * found. A transform that silently matches nothing is the failure mode this
 * guards against — the same class of bug as a string-replace that no-ops.
 */
function collectEdits(
  text: string,
  baseName: string,
): { edits: Edit[]; mathmlRemoved: number; domEmitRemoved: number } {
  const tokens = tokenize(text);
  const edits: Edit[] = [];
  let mathmlRemoved = 0;
  let domEmitRemoved = 0;
  const stripDomEmit = DOM_EMIT_FILES.has(baseName);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind !== SyntaxKind.Identifier) continue;

    // A MathML type named in an `implements` clause. `tree.ts` declares
    // `class DocumentFragment … implements HtmlDomNode, MathDomNode`, and the
    // name survives every other rule here: it is not a declaration, not a
    // property, and not a method, so the import gets pruned while the reference
    // stays and fails to resolve. Drop just that name from the list, keeping the
    // clause itself and any non-MathML entries in it.
    if (MATHML_NAMES.has(tok.text) && inHeritageClause(tokens, i)) {
      const prev = tokens[i - 1];
      if (prev?.kind === SyntaxKind.CommaToken) {
        // `A, MathDomNode` -> `A`
        edits.push({ start: prev.fullStart, end: tok.end });
      } else if (tokens[i + 1]?.kind === SyntaxKind.CommaToken) {
        // `MathDomNode, A` -> `A`
        edits.push({ start: tok.fullStart, end: tokens[i + 1].end });
      } else {
        // The sole entry: remove the whole clause keyword too.
        const kw = tokens[i - 1];
        edits.push({ start: kw ? kw.fullStart : tok.fullStart, end: tok.end });
      }
      mathmlRemoved++;
      continue;
    }

    if (MATHML_DECLARATIONS.has(tok.text)) {
      // Two distinct shapes, and they must be cut differently:
      //
      // - a *declaration* (`const mathmlBuilder = …`, `function mathmlBuilder(…)`,
      //   `export const stretchyMathML = …`) takes its entire statement;
      // - a *reference* (the shorthand `{type, htmlBuilder, mathmlBuilder}` or
      //   `mathmlBuilder: (g, o) => …`) takes only the property.
      //
      // Anything else — a call to one of these from code we keep — must be left
      // alone, and is filtered out by requiring one of those two contexts.
      const prev = tokens[i - 1];
      const isDeclaration =
        prev &&
        (prev.kind === SyntaxKind.ConstKeyword ||
          prev.kind === SyntaxKind.LetKeyword ||
          prev.kind === SyntaxKind.FunctionKeyword);

      if (isDeclaration) {
        // Include a preceding `export` so the modifier is not orphaned.
        let declStart = i - 1;
        if (tokens[declStart - 1]?.kind === SyntaxKind.ExportKeyword) declStart--;
        const last = endOfDeclaration(tokens, i);
        edits.push(expandToFullLines(text, tokens[declStart].fullStart, tokens[last].end));
        mathmlRemoved++;
      } else if (tok.text === 'mathmlBuilder') {
        const last = endOfValue(tokens, i);
        edits.push(expandToFullLines(text, tok.fullStart, tokens[last].end));
        mathmlRemoved++;
      } else if (isMemberDeclaration(tokens, i)) {
        // A class *method*, which is neither of the two shapes above:
        // `tree.ts`'s `toText()` is a member of `DocumentFragment`, so it has no
        // `const`/`function` keyword before it and is not a property
        // assignment. Without this branch it survives the strip and then fails
        // to compile, because it references the pruned MathML type.
        //
        // `isMemberDeclaration` is what keeps this from eating *call sites*:
        // matching on "identifier followed by `(`" alone also matches
        // `child.toText()` and `pad(...)`, and cutting from there to the
        // matching paren removes the middle of an expression. Measured: without
        // the guard this turned `return child.toText();` into `return child.`
        // and cut `pad(...)` out of a ternary in four `functions/` files —
        // 6 syntax errors, and *more* lines left in the tree than before,
        // because a broken cut leaves both halves.
        const last = endOfMethod(tokens, i);
        if (last > i) {
          edits.push(expandToFullLines(text, tok.fullStart, tokens[last].end));
          mathmlRemoved++;
        }
      }
      continue;
    }

    if (stripDomEmit && (tok.text === 'toNode' || tok.text === 'toMarkup')) {
      const next = tokens[i + 1];
      const prev = tokens[i - 1];
      // Only a definition, never a call: `toNode(): Node {` or
      // `const toNode = function(…)`. A call site reads `child.toNode()`, which
      // this rejects on the preceding `.`.
      const isCall = prev && prev.kind === SyntaxKind.DotToken;
      if (isCall || !next) continue;

      const isMethod = next.kind === SyntaxKind.OpenParenToken;
      const isConst =
        prev && (prev.kind === SyntaxKind.ConstKeyword || prev.kind === SyntaxKind.LetKeyword);

      if (isConst) {
        const last = endOfDeclaration(tokens, i);
        edits.push(expandToFullLines(text, tokens[i - 1].fullStart, tokens[last].end));
        domEmitRemoved++;
      } else if (isMethod) {
        // Walk to the method body's closing brace.
        //
        // A bodiless *signature* has to be handled separately, not skipped.
        // `tree.ts` declares `toNode(): Node;` on the `VirtualNode` interface
        // that every node in the tree is typed against, with no body at all.
        // Requiring a `{` before the terminating `}` keeps the walk from running
        // off the end of the token list looking for a body that never arrives —
        // but the declaration must still be **removed**, because leaving a
        // required member whose every implementation has been stripped makes the
        // interface unsatisfiable and no concrete class type-checks against it.
        // Measured: leaving these two signatures produced 100+ TS2739/TS2677
        // errors across the kernel, every one reducing to "Type 'Span' is
        // missing the following properties: toNode, toMarkup".
        let j = i + 1;
        let depth = 0;
        let sawBody = false;
        let terminated = false;
        for (; j < tokens.length; j++) {
          const kind = tokens[j].kind;
          if (kind === SyntaxKind.SemicolonToken && depth === 0 && !sawBody) {
            // A bodiless signature: delete through the semicolon.
            edits.push(expandToFullLines(text, tokens[i].fullStart, tokens[j].end));
            domEmitRemoved++;
            break;
          }
          if (OPENERS.has(kind)) {
            depth++;
            if (kind === SyntaxKind.OpenBraceToken) sawBody = true;
          } else if (CLOSERS.has(kind)) {
            depth--;
            if (depth === 0 && sawBody) {
              terminated = true;
              break;
            }
          }
        }
        if (terminated) {
          edits.push(expandToFullLines(text, tok.fullStart, tokens[j].end));
          domEmitRemoved++;
        }
      }
      continue;
    }
  }

  // MathML imports, collected separately because they are statement-oriented
  // while the walk above is identifier-oriented.
  const imports = collectImportEdits(text, tokens);
  edits.push(...imports.edits);
  mathmlRemoved += imports.removed;

  return { edits, mathmlRemoved, domEmitRemoved };
}

/**
 * Removes `import … from "…/buildMathML"` and `"…/mathMLTree"` wholesale, and
 * prunes MathML names out of a mixed named import (`{HtmlDomNode, MathDomNode}`)
 * while keeping the surviving clause syntactically valid.
 *
 * Returns one edit per removed *statement* plus zero or more member edits; only
 * statements are counted, so the reported total stays comparable to a grep of
 * upstream.
 */
function collectImportEdits(text: string, tokens: Tok[]): { edits: Edit[]; removed: number } {
  const edits: Edit[] = [];
  let removed = 0;

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind !== SyntaxKind.ImportKeyword) continue;

    // Walk to the module specifier, then to the terminating semicolon.
    let specIdx = -1;
    for (let k = i; k < tokens.length; k++) {
      if (tokens[k].kind === SyntaxKind.StringLiteral) {
        specIdx = k;
        break;
      }
      if (tokens[k].kind === SyntaxKind.SemicolonToken) break;
    }
    if (specIdx < 0) continue;

    let endIdx = specIdx;
    while (endIdx < tokens.length - 1 && tokens[endIdx].kind !== SyntaxKind.SemicolonToken) {
      endIdx++;
    }
    const specifier = tokens[specIdx].text.slice(1, -1);
    const statementEdit = expandToFullLines(text, tokens[i].fullStart, tokens[endIdx].end);

    if (/(^|\/)(buildMathML|mathMLTree)(\.[jt]s)?$/.test(specifier)) {
      edits.push(statementEdit);
      removed++;
      i = endIdx;
      continue;
    }

    // A mixed named import keeps its non-MathML members.
    const members: number[] = [];
    let inBraces = false;
    for (let k = i + 1; k < specIdx; k++) {
      if (tokens[k].kind === SyntaxKind.OpenBraceToken) {
        inBraces = true;
        continue;
      }
      if (tokens[k].kind === SyntaxKind.CloseBraceToken) break;
      // A named import member is an identifier that is not preceded by `as`,
      // so an aliased `{X as Y}` contributes only `X` — which is the name that
      // decides whether the member belongs to the MathML layer.
      if (
        inBraces &&
        tokens[k].kind === SyntaxKind.Identifier &&
        tokens[k - 1].kind !== SyntaxKind.Identifier
      ) {
        members.push(k);
      }
    }
    const doomed = members.filter((k) => MATHML_NAMES.has(tokens[k].text));
    if (doomed.length === 0) {
      i = endIdx;
      continue;
    }
    if (doomed.length === members.length) {
      edits.push(statementEdit);
      removed++;
      i = endIdx;
      continue;
    }

    for (const k of doomed) {
      const pos = members.indexOf(k);
      // Take the comma on whichever side exists, so the list never ends up with
      // a doubled or dangling separator.
      const from = pos > 0 ? tokens[members[pos - 1]].end : tokens[k].start;
      const to = pos > 0 ? tokens[k].end : tokens[members[pos + 1]].start;
      edits.push({ start: from, end: to });
    }
    removed++;
    i = endIdx;
  }

  return { edits, removed };
}

/**
 * Repoints imports of the hand-written registry files at `src/registry/`.
 *
 * The vendored builders import `"../defineFunction"` relative to their own
 * location, but those two modules now live outside `src/kernel/`, so every import
 * of them has to climb one extra level. Done textually on the module specifier
 * only: the specifier is unambiguous, and rewriting it in the AST would mean
 * re-printing the file and losing the upstream formatting this transform
 * deliberately preserves.
 */
function redirectHandWrittenImports(text: string, rel: string): string {
  // `src/registry/` is a *sibling* of `src/kernel/`, so a file at the top of the
  // kernel climbs one level and one in `functions/` climbs two:
  // `buildCommon.ts` → `../registry/x`, `functions/op.ts` → `../../registry/x`.
  const depth = rel.split('/').length - 1;
  const prefix = `${'../'.repeat(depth + 1)}registry/`;

  let out = text;
  for (const name of HAND_WRITTEN) {
    const stem = name.replace(/\.ts$/, '');
    // Match only a module specifier: quote, optional `./` or `../` run, the stem,
    // then the closing quote. This cannot touch an identifier of the same name.
    const pattern = new RegExp(`(["'])(?:\\.{1,2}/)+${stem}\\1`, 'g');
    out = out.replace(pattern, `$1${prefix}${stem}$1`);
  }
  return out;
}

function collectSourceFiles(sourceDir: string): string[] {
  const files: string[] = [...KEEP_FILES];
  for (const dir of KEEP_DIRS) {
    const walk = (rel: string) => {
      const abs = join(sourceDir, rel);
      if (!existsSync(abs)) return;
      for (const entry of readdirSync(abs)) {
        const entryRel = join(rel, entry);
        if (statSync(join(sourceDir, entryRel)).isDirectory()) walk(entryRel);
        else files.push(entryRel);
      }
    };
    walk(dir);
  }
  return files;
}

function vendor(sourceDir: string, outDir: string): FileStats[] {
  const stats: FileStats[] = [];

  for (const rel of collectSourceFiles(sourceDir)) {
    const from = join(sourceDir, rel);
    const bytes = tryRead(from);
    if (bytes === null) {
      throw new Error(`vendor-katex: expected source file is missing: ${from}`);
    }
    const original = bytes.toString('utf8');
    const baseName = rel.split('/').pop() as string;

    let output = original;
    let mathmlRemoved = 0;
    let domEmitRemoved = 0;

    // The `.js` metric and symbol tables carry no MathML or DOM code, so a token
    // walk over them can only find nothing. Copy them verbatim.
    if (rel.endsWith('.ts') && !rel.endsWith('.d.ts')) {
      const result = collectEdits(original, baseName);
      output = applyEdits(original, result.edits);
      output = redirectHandWrittenImports(output, rel);
      mathmlRemoved = result.mathmlRemoved;
      domEmitRemoved = result.domEmitRemoved;
    }

    const to = join(outDir, rel);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, output);

    stats.push({
      path: rel,
      linesBefore: original.split('\n').length,
      linesAfter: output.split('\n').length,
      bytesBefore: Buffer.byteLength(original),
      bytesAfter: Buffer.byteLength(output),
      mathmlRemoved,
      domEmitRemoved,
    });
  }

  return stats;
}

/**
 * Records the upstream hash of each hand-written registry file, and reports which
 * have changed upstream since they were last reconciled.
 *
 * A hand-written replacement is a fork with no diff pressure: if KaTeX changes
 * `defineFunction.ts` — adding a field to `FunctionSpec`, say — nothing here would
 * notice, and the kernel would silently keep the old contract while the vendored
 * builders around it moved on. Hashing the upstream file at vendor time turns that
 * into a reported drift.
 *
 * The recorded hashes live in `src/registry/UPSTREAM.json`, written on the first
 * run and compared on every later one.
 */
/**
 * Read a file, returning `null` if it does not exist.
 *
 * Preferred over `existsSync(p) && readFileSync(p)` throughout this script: the
 * two-step form is a time-of-check/time-of-use race, and the single-step form is
 * also the only one that cannot report a file as present and then fail to read
 * it. Any error other than a missing file still propagates — a permission error
 * should stop the vendor run, not be silently treated as absence.
 */
function tryRead(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function checkHandWritten(sourceDir: string, pkgRoot: string): string[] {
  const manifestPath = join(pkgRoot, 'src/registry/UPSTREAM.json');
  const current: Record<string, string> = {};

  // Read and branch on ENOENT rather than checking existence and then reading:
  // the two-step form leaves a time-of-check/time-of-use gap, and here it would
  // also hash a file that had been replaced between the check and the read,
  // which is precisely the drift this guard exists to detect.
  for (const name of HAND_WRITTEN) {
    const upstream = join(sourceDir, name);
    const bytes = tryRead(upstream);
    current[name] =
      bytes === null ? 'missing' : createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  }

  const manifest = tryRead(manifestPath);
  if (manifest === null) {
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(current, null, 2)}\n`);
    return [];
  }

  const recorded = JSON.parse(manifest.toString('utf8')) as Record<string, string>;
  return HAND_WRITTEN.filter((name) => recorded[name] !== current[name]);
}

/**
 * The workspace root holding `references/` beside the `vectojs` repo.
 *
 * Resolved through `git rev-parse --git-common-dir` rather than by counting `..`
 * segments, because a `carryctx worktree` checkout lives at
 * `vectojs/.worktrees/<task>/` — one level deeper than a plain clone — so a fixed
 * relative path resolves correctly from one and silently misses from the other.
 */
function workspaceRoot(pkgRoot: string): string {
  try {
    const commonDir = execFileSync('git', ['-C', pkgRoot, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
    }).trim();
    return resolve(dirname(resolve(pkgRoot, commonDir)), '..');
  } catch {
    return resolve(pkgRoot, '../../..');
  }
}

function upstreamCommit(sourceRepo: string): string {
  try {
    return execFileSync('git', ['-C', sourceRepo, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

/* ------------------------------------------------------------------------- *
 * Emit-constants drift guard.
 *
 * The emit layer in `src/emit/` hand-transcribes constants from upstream files
 * this script does NOT vendor: `styles/katex.scss` and `Options.ts` stay
 * upstream, so until now nothing noticed when a stylesheet value moved — a
 * changed `$mu`, delimiter space or size multiplier would silently misplace
 * rules, delimiters or scripts (issue #611). The functions below re-derive
 * every guarded constant from the upstream sources and compare them with what
 * the committed emit layer encodes, on every vendor run in either mode.
 *
 * Scope note: the `AVAILABLE` face inventory in `fonts.ts` describes which
 * weight/style combinations ship as TTF files — a property of the fonts, not
 * of the stylesheet — and is deliberately not guarded here.
 * ------------------------------------------------------------------------- */

/** A flattened SCSS rule: resolved selector plus its declarations. */
export interface FlatRule {
  selector: string;
  decls: Record<string, string>;
}

/** Class tokens that are structure, never an alignment-bearing owner. */
const STRUCTURAL_CLASSES = new Set(['span', 'vlist', 'vlist-t', 'vlist-t2', 'vlist-r', 'pstrut']);

/**
 * Emitted alignment entries with no upstream `text-align` rule, each with the
 * reason the deviation is deliberate. A key here still fails the guard once
 * upstream declares a *different* alignment for it.
 */
const EXPECTED_ROW_ALIGN_DEVIATIONS: Record<string, { align: string; reason: string }> = {
  sqrt: {
    align: 'center',
    reason:
      'upstream has no text-align rule under .sqrt (the old comment cited katex.scss:406, ' +
      'which is .op-limits). Kept because both sqrt rows measure equal width, making ' +
      'centering output-neutral; revisit if sqrt ever grows unequal rows.',
  },
};

/**
 * The upstream values the guard extracted from the current KaTeX checkout.
 * Numeric fields are `null` when their declaration is absent, which is itself
 * drift when the committed side still has the constant.
 */
export interface UpstreamEmitConstants {
  /** Denominator of `$mu: calc(1em / N)`; null when absent. */
  muDenominator: number | null;
  /** `$nulldelimiterspace` in em; null when absent. */
  nullDelimiterSpace: number | null;
  /** `$sizes:` list from katex.scss. */
  scssSizes: number[];
  /** `sizeMultipliers` array from Options.ts. */
  optionsSizes: number[];
  /**
   * Family/weight/style per single-class font rule, e.g. `.mathbf -> Main,
   * bold`. Axes the rule does not set are absent; family is null when the rule
   * sets only weight/style.
   */
  classFaces: Record<string, { family: string | null; bold?: boolean; italic?: boolean }>;
  /** `delimsizing sizeN -> SizeN-Regular`. */
  delimSizeFonts: Record<string, string>;
  /** `small-op` / `large-op` / `delim-sizeN -> their dedicated faces. */
  directFontClasses: Record<string, string>;
  /**
   * Every text-align declaration upstream makes, as (selector, value) pairs.
   * Unfiltered here; the checker decides which ones position vlist rows.
   */
  alignRules: { selector: string; align: string }[];
  /** Family named by the `.katex { font: ... }` default shorthand. */
  defaultFontFamily: string | null;
}

/**
 * Resolves SCSS nesting into flat `(selector, decls)` pairs.
 *
 * Only the subset of SCSS katex.scss uses: nested selectors, `&`, comma
 * groups, line and block comments, and declarations (including `$var:` ones).
 * A nested chunk without `&` is appended to each parent with a descendant
 * combinator; a chunk with `&` replaces the `&` with each parent - the
 * composition CSS semantics SCSS defines. Declarations are split on the first
 * `:`, which is safe here because selector chunks never carry a declaration
 * fragment before their `{`.
 */
export function flattenScss(text: string): FlatRule[] {
  // Strip comments first: they may contain braces, which would corrupt the
  // block structure below.
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  const rules: FlatRule[] = [];

  interface Frame {
    /** Resolved selector of this block ('' for the synthetic root). */
    parents: string[];
    decls: Record<string, string>;
    buffer: string;
    isRoot: boolean;
  }

  const flushDecl = (frame: Frame) => {
    const idx = frame.buffer.indexOf(':');
    if (idx > 0) {
      frame.decls[frame.buffer.slice(0, idx).trim()] = frame.buffer.slice(idx + 1).trim();
    }
    frame.buffer = '';
  };

  const stack: Frame[] = [{ parents: [''], decls: {}, buffer: '', isRoot: true }];
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const top = stack[stack.length - 1];

    if (ch === '{') {
      const resolved: string[] = [];
      for (const chunk of top.buffer.split(',')) {
        const sel = chunk.trim();
        if (!sel) continue;
        for (const parent of top.parents) {
          resolved.push(
            sel.includes('&')
              ? sel.replaceAll('&', parent).trim()
              : parent
                ? `${parent} ${sel}`
                : sel,
          );
        }
      }
      // Record the rule as soon as it OPENS, and keep mutating its decls:
      // children then appear after their parent, matching document order.
      // Pure containers (.delimsizing holds only nested rules) end up with no
      // declarations and are dropped by the final filter.
      const frame: Frame = { parents: resolved, decls: {}, buffer: '', isRoot: false };
      rules.push({ selector: frame.parents.join(', '), decls: frame.decls });
      stack.push(frame);
      top.buffer = '';
      continue;
    }

    if (ch === '}') {
      if (top.buffer.trim()) flushDecl(top);
      stack.pop();
      continue;
    }

    if (ch === ';') {
      if (top.buffer.trim()) flushDecl(top);
      continue;
    }

    top.buffer += ch;
  }
  return rules.filter((rule) => Object.keys(rule.decls).length > 0);
}

/** All numeric literals in `raw`, preserving order. */
function numberList(raw: string): number[] {
  return (raw.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/**
 * Extracts every constant the guard checks, from the upstream checkout's
 * `src/` directory. Throws when a source file is missing: a vanished
 * stylesheet must stop the vendor run, not pass as "nothing drifted".
 */
export function extractUpstreamEmitConstants(sourceDir: string): UpstreamEmitConstants {
  const scssBytes = tryRead(join(sourceDir, 'styles/katex.scss'));
  if (scssBytes === null) {
    throw new Error(
      `vendor-katex: missing upstream stylesheet: ${join(sourceDir, 'styles/katex.scss')}`,
    );
  }
  const optionsBytes = tryRead(join(sourceDir, 'Options.ts'));
  if (optionsBytes === null) {
    throw new Error(`vendor-katex: missing upstream Options.ts: ${join(sourceDir, 'Options.ts')}`);
  }
  const scss = scssBytes.toString('utf8');

  const out: UpstreamEmitConstants = {
    muDenominator: null,
    nullDelimiterSpace: null,
    scssSizes: [],
    optionsSizes: [],
    classFaces: {},
    delimSizeFonts: {},
    directFontClasses: {},
    alignRules: [],
    defaultFontFamily: null,
  };

  // Scalar variables, read from the raw text: their position in the nesting
  // carries no information, and the declarations sit inside blocks the
  // flattener would otherwise have to surface specially.
  const mu = /\$mu\s*:\s*calc\(\s*1em\s*\/\s*(\d+(?:\.\d+)?)\s*\)/.exec(scss);
  if (mu) out.muDenominator = Number(mu[1]);

  const ptPerEm = /\$ptperem\s*:\s*(\d+(?:\.\d+)?)\s*;/.exec(scss);
  const nds = /\$nulldelimiterspace\s*:\s*calc\(\s*([\d.]+)em\s*\/\s*\$ptperem\s*\)/.exec(scss);
  if (ptPerEm && nds) out.nullDelimiterSpace = Number(nds[1]) / Number(ptPerEm[1]);

  const sizes = /\$sizes\s*:\s*([^;]+);/.exec(scss);
  if (sizes) out.scssSizes = numberList(sizes[1]);

  const optSizes = /sizeMultipliers\s*=\s*\[([^\]]*)\]/.exec(optionsBytes.toString('utf8'));
  if (optSizes) out.optionsSizes = numberList(optSizes[1]);

  for (const { selector, decls } of flattenScss(scss)) {
    // A flattened grouped rule shares one decls object across all its
    // resolved selectors, and every group must contribute its own class
    // (`.mathbb, .textbb { ... }` names two faces, not one).
    for (const group of selector.split(',')) {
      const sel = group.trim();
      if (!sel) continue;
      const lastCompound =
        sel
          .split(/[>+~\s]+/)
          .filter(Boolean)
          .pop() ?? '';
      const classes = [...lastCompound.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]);

      // Font-bearing rules: a single-class compound selects a face outright;
      // `&.sizeN` under .delimsizing and `.op-symbol.small-op|large-op` pick the
      // dedicated delimiter/op faces; `.delim-sizeN` appears mid-selector under
      // `.delimsizing.mult`.
      const familyMatch = /^KaTeX_([A-Za-z0-9]+)/.exec(decls['font-family'] ?? '');
      if (familyMatch) {
        const font = `${familyMatch[1]}-Regular`;
        if (classes.length === 1 && !STRUCTURAL_CLASSES.has(classes[0])) {
          // Recorded together with the axis-only rules below.
        } else if (classes.length >= 2 && classes[0] === 'delimsizing') {
          const m = /^size(\d)$/.exec(classes[classes.length - 1]);
          if (m) out.delimSizeFonts[`size${m[1]}`] = font;
        } else if (classes.length >= 2) {
          out.directFontClasses[classes[classes.length - 1]] = font;
        }
        const ds = /\.delim-size(\d)(?![\w-])/.exec(sel);
        if (ds) out.directFontClasses[`delim-size${ds[1]}`] = font;
      }

      // Every single-class rule that sets ANY font axis is recorded, including
      // weight/style-only rules like `.textbf` - those have no font-family line,
      // and dropping one silently would be exactly the drift this guard exists
      // to report.
      const setsFontAxis =
        familyMatch !== null ||
        decls['font-weight'] !== undefined ||
        decls['font-style'] !== undefined;
      if (setsFontAxis && classes.length === 1 && !STRUCTURAL_CLASSES.has(classes[0])) {
        out.classFaces[classes[0]] = {
          family: familyMatch ? familyMatch[1] : null,
          ...(decls['font-weight'] === 'bold' ? { bold: true } : {}),
          ...(decls['font-style'] === 'italic'
            ? { italic: true }
            : decls['font-style'] === 'normal'
              ? { italic: false }
              : {}),
        };
      }

      // Every text-align is recorded; the checker separates the vlist-
      // positioning rules from cosmetic ones (.svg-align, .cd-label-left).
      const ta = decls['text-align'];
      if (ta === 'left' || ta === 'center' || ta === 'right') {
        out.alignRules.push({ selector: sel, align: ta });
      }

      // The default-face shorthand: `.katex { font: normal 1.21em KaTeX_Main ... }`.
      if (decls['font']) {
        const fam = /^[\w-]+\s+[\d.]+em\s+KaTeX_([A-Za-z0-9]+)/.exec(decls['font']);
        if (fam) out.defaultFontFamily = fam[1];
      }
    }
  }

  return out;
}

/** Compares one numeric pair within float-print tolerance. */
function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-12;
}

/**
 * Re-extracts the upstream constants and diffs them against the committed emit
 * tables. Returns human-readable drift messages; empty means clean. Each
 * message names both sides so the fix (update the emit table, or re-record the
 * upstream value deliberately) starts from evidence.
 */
export function checkEmitConstants(sourceDir: string): string[] {
  const up = extractUpstreamEmitConstants(sourceDir);
  const drift: string[] = [];

  if (up.muDenominator === null) {
    drift.push('$mu disappeared from katex.scss; emit MU has nothing to anchor to');
  } else if (!close(MU, 1 / up.muDenominator)) {
    drift.push(`$mu is now 1/${up.muDenominator} em but emit MU is ${MU} (src/emit/svg.ts)`);
  }

  if (up.nullDelimiterSpace === null) {
    drift.push('$nulldelimiterspace disappeared from katex.scss');
  } else if (!close(NULL_DELIMITER_SPACE, up.nullDelimiterSpace)) {
    drift.push(
      `$nulldelimiterspace is now ${up.nullDelimiterSpace} em but emit NULL_DELIMITER_SPACE is ` +
        `${NULL_DELIMITER_SPACE} (src/emit/svg.ts)`,
    );
  }

  const sizesDrift = (got: number[]): boolean =>
    got.length !== SIZE_MULTIPLIERS.length || got.some((v, i) => v !== SIZE_MULTIPLIERS[i]);
  if (up.scssSizes.length === 0) {
    drift.push('$sizes list missing from katex.scss');
  } else if (sizesDrift(up.scssSizes)) {
    drift.push(
      `katex.scss $sizes is [${up.scssSizes}] but emit SIZE_MULTIPLIERS is ` +
        `[${SIZE_MULTIPLIERS}] (src/emit/fonts.ts)`,
    );
  }
  if (up.optionsSizes.length === 0) {
    drift.push('sizeMultipliers missing from Options.ts');
  } else if (sizesDrift(up.optionsSizes)) {
    drift.push(
      `Options.ts sizeMultipliers is [${up.optionsSizes}] but emit SIZE_MULTIPLIERS is ` +
        `[${SIZE_MULTIPLIERS}] (src/emit/fonts.ts)`,
    );
  }

  if (up.defaultFontFamily === null) {
    drift.push('.katex default font shorthand missing from katex.scss');
  } else if (`${up.defaultFontFamily}-Regular` !== DEFAULT_FONT) {
    drift.push(
      `.katex default font is now KaTeX_${up.defaultFontFamily} but emit DEFAULT_FONT is ` +
        `${DEFAULT_FONT} (src/emit/fonts.ts)`,
    );
  }

  // Class-to-face tables, compared axis-by-axis; null/undefined means "not
  // set", which must agree with "not set" on the other side.
  for (const [cls, face] of Object.entries(up.classFaces)) {
    const mine = CLASS_TO_FACE[cls];
    if (!mine) {
      drift.push(`upstream font class .${cls} is not encoded in CLASS_TO_FACE (src/emit/fonts.ts)`);
      continue;
    }
    if ((face.family ?? '') !== (mine.family ?? '')) {
      drift.push(
        `.${cls} family is now ${face.family ?? '(none)'} but CLASS_TO_FACE says '${mine.family}'`,
      );
    }
    if ((face.bold ?? false) !== (mine.bold ?? false)) {
      drift.push(
        `.${cls} bold is now ${face.bold ?? false} but CLASS_TO_FACE says ${mine.bold ?? false}`,
      );
    }
    if ((face.italic ?? undefined) !== (mine.italic ?? undefined)) {
      drift.push(
        `.${cls} italic is now ${face.italic ?? '(unset)'} but CLASS_TO_FACE says ` +
          `${mine.italic ?? '(unset)'}`,
      );
    }
  }
  for (const cls of Object.keys(CLASS_TO_FACE)) {
    if (!(cls in up.classFaces)) {
      drift.push(`CLASS_TO_FACE entry .${cls} has no matching font-axis rule in katex.scss`);
    }
  }

  for (const [cls, font] of Object.entries(up.delimSizeFonts)) {
    if (DELIM_SIZE_FONTS[cls] !== font) {
      drift.push(
        `delimsizing ${cls} maps to ${font} upstream but DELIM_SIZE_FONTS says ` +
          `${DELIM_SIZE_FONTS[cls]}`,
      );
    }
  }
  for (const cls of Object.keys(DELIM_SIZE_FONTS)) {
    if (!(cls in up.delimSizeFonts)) {
      drift.push(`DELIM_SIZE_FONTS entry ${cls} has no matching rule in katex.scss`);
    }
  }

  for (const [cls, font] of Object.entries(up.directFontClasses)) {
    if (DIRECT_FONT_CLASSES[cls] !== font) {
      drift.push(
        `${cls} maps to ${font} upstream but DIRECT_FONT_CLASSES says ${DIRECT_FONT_CLASSES[cls]}`,
      );
    }
  }
  for (const cls of Object.keys(DIRECT_FONT_CLASSES)) {
    if (!(cls in up.directFontClasses)) {
      drift.push(`DIRECT_FONT_CLASSES entry ${cls} has no matching rule in katex.scss`);
    }
  }

  // Direction one: every emitted key must have an upstream rule that names
  // its class — found by class match, whatever selector shape carries it.
  const alignFor = (key: string): string | undefined => {
    const re = new RegExp(`\\.${key}(?![\\w-])`);
    return up.alignRules.find((rule) => re.test(rule.selector))?.align;
  };
  for (const [key, mine] of Object.entries(ROW_ALIGN_CLASSES)) {
    const want = alignFor(key) ?? EXPECTED_ROW_ALIGN_DEVIATIONS[key]?.align;
    if (want === undefined) {
      drift.push(
        `ROW_ALIGN_CLASSES entry ${key} has no upstream text-align rule and no recorded deviation`,
      );
    } else if (want !== mine) {
      drift.push(`upstream aligns ${key} to ${want} but ROW_ALIGN_CLASSES says ${mine}`);
    }
  }

  // Direction two: an upstream rule that positions vlist rows through a class
  // the emit layer neither encodes nor records as a deviation. Scoped to
  // selectors that reach a vlist (or the mfrac double-span shape), so
  // cosmetic text-aligns (.svg-align, .cd-label-left, display math centering)
  // do not read as drift.
  for (const rule of up.alignRules) {
    if (!/vlist-t/.test(rule.selector) && !/> span > span/.test(rule.selector)) continue;
    const owners = [...rule.selector.matchAll(/\.([A-Za-z][\w-]*)/g)]
      .map((m) => m[1])
      .filter((c) => !STRUCTURAL_CLASSES.has(c));
    const candidate = owners[owners.length - 1];
    if (!candidate) continue;
    if (candidate in ROW_ALIGN_CLASSES || candidate in EXPECTED_ROW_ALIGN_DEVIATIONS) continue;
    drift.push(
      `upstream positions vlists of .${candidate} to ${rule.align} but ` +
        'ROW_ALIGN_CLASSES does not encode it',
    );
  }

  return drift;
}

function main() {
  const args = process.argv.slice(2);
  const sourceIdx = args.indexOf('--source');
  const check = args.includes('--check');

  const pkgRoot = resolve(import.meta.dir, '..');
  const defaultSource = resolve(workspaceRoot(pkgRoot), 'references/math/KaTeX');
  const sourceRepo = sourceIdx >= 0 ? resolve(args[sourceIdx + 1]) : defaultSource;
  const sourceDir = join(sourceRepo, 'src');

  if (!existsSync(sourceDir)) {
    console.error(
      `vendor-katex: no KaTeX source at ${sourceDir}\n` +
        `Pass --source <path-to-katex-checkout>, or clone KaTeX to ${defaultSource}.`,
    );
    process.exit(1);
  }

  const commit = upstreamCommit(sourceRepo);
  const committedDir = join(pkgRoot, 'src/kernel');
  const outDir = check ? mkdtempSync(join(tmpdir(), 'vendor-katex-')) : committedDir;

  // Check the hand-written files BEFORE clearing the output directory. This ran
  // after the `rmSync` once, threw, and left `src/kernel/` missing its
  // `VENDORED.md` — the delete had already happened and the write that recreates
  // it never ran. Anything that can fail must fail while the committed tree is
  // still intact.
  const drifted = checkHandWritten(sourceDir, pkgRoot);

  // The emit-constants guard runs in both modes and fails before anything is
  // written, for the same fail-early reason as above.
  const constantsDrift = checkEmitConstants(sourceDir);
  if (constantsDrift.length > 0) {
    console.error(
      `vendor-katex: ${constantsDrift.length} emit constant(s) diverged from upstream:\n` +
        constantsDrift.map((d) => `  - ${d}`).join('\n') +
        `\nUpdate src/emit/ to the new upstream values (after re-verifying the affected ` +
        `placements against a real browser), then re-run.`,
    );
    process.exit(1);
  }

  if (!check) rmSync(committedDir, { recursive: true, force: true });

  const stats = vendor(sourceDir, outDir);

  const totals = stats.reduce(
    (acc, s) => ({
      linesBefore: acc.linesBefore + s.linesBefore,
      linesAfter: acc.linesAfter + s.linesAfter,
      bytesBefore: acc.bytesBefore + s.bytesBefore,
      bytesAfter: acc.bytesAfter + s.bytesAfter,
      mathmlRemoved: acc.mathmlRemoved + s.mathmlRemoved,
      domEmitRemoved: acc.domEmitRemoved + s.domEmitRemoved,
    }),
    {
      linesBefore: 0,
      linesAfter: 0,
      bytesBefore: 0,
      bytesAfter: 0,
      mathmlRemoved: 0,
      domEmitRemoved: 0,
    },
  );

  // A transform that matched nothing is a silent failure, not a clean run.
  // Upstream at 5a5bf206 has 79 `mathmlBuilder` sites and 12 DOM emit methods;
  // assert a plausible floor rather than an exact count, so a KaTeX refactor
  // reports a real number instead of tripping an unrelated assertion.
  if (totals.mathmlRemoved < 40) {
    console.error(
      `vendor-katex: only ${totals.mathmlRemoved} MathML sites removed; expected 40+.\n` +
        `Upstream layout probably changed — inspect before trusting this output.`,
    );
    process.exit(1);
  }
  if (totals.domEmitRemoved < 10) {
    console.error(
      `vendor-katex: only ${totals.domEmitRemoved} DOM emit methods removed; expected 10+.`,
    );
    process.exit(1);
  }

  // Write the manifest into whichever directory this run produced, BEFORE the
  // `--check` comparison. Writing it only on the non-check path made `--check`
  // compare a committed tree that has `VENDORED.md` against a temp tree that
  // never gets one, so it reported a spurious 16-line deletion and could never
  // pass — the guard was advertised as working while being unconditionally
  // broken.
  writeFileSync(
    join(outDir, 'VENDORED.md'),
    `# Vendored KaTeX kernel — do not edit by hand

Generated by \`packages/tex/scripts/vendor-katex.ts\`. Re-run that instead of
editing anything here; \`bun run vendor --check\` fails if the two have diverged.

- Upstream: <https://github.com/KaTeX/KaTeX>
- Commit: \`${commit}\`
- License: MIT (see \`LICENSE-KaTeX\` in the package root)
- Files: ${stats.length}
- Lines: ${totals.linesBefore} upstream → ${totals.linesAfter} vendored
- MathML sites removed: ${totals.mathmlRemoved}
- DOM emit methods removed: ${totals.domEmitRemoved}

Removed: \`buildMathML\`, \`mathMLTree\`, every \`mathmlBuilder\`, and the
\`toNode\`/\`toMarkup\` DOM emission. Parse and layout are untouched — the SVG emit
layer in \`../emit/\` translates the span tree and does not re-derive layout.
`,
  );

  if (check) {
    let diff = '';
    try {
      execFileSync('git', ['diff', '--no-index', '--stat', committedDir, outDir], {
        encoding: 'utf8',
      });
    } catch (e) {
      diff = (e as { stdout?: string }).stdout ?? 'diff failed';
    }
    rmSync(outDir, { recursive: true, force: true });
    if (diff.trim()) {
      console.error(
        `vendor-katex --check: src/kernel/ differs from the transform output:\n${diff}`,
      );
      process.exit(1);
    }
    console.log('vendor-katex --check: src/kernel/ matches the transform output.');
    return;
  }

  const pct = (100 * (totals.bytesBefore - totals.bytesAfter)) / totals.bytesBefore;
  console.log(`vendor-katex: KaTeX ${commit.slice(0, 8)} → ${relative(pkgRoot, committedDir)}`);
  console.log(`  files              ${stats.length}`);
  console.log(`  lines              ${totals.linesBefore} → ${totals.linesAfter}`);
  console.log(
    `  bytes              ${totals.bytesBefore} → ${totals.bytesAfter} (-${pct.toFixed(1)}%)`,
  );
  console.log(`  MathML removed     ${totals.mathmlRemoved} sites`);
  console.log(`  DOM emit removed   ${totals.domEmitRemoved} methods`);
  console.log(`  hand-written       ${HAND_WRITTEN.join(', ')} (in src/registry/)`);

  if (drifted.length > 0) {
    console.error(
      `\nvendor-katex: upstream changed ${drifted.length} hand-written file(s): ${drifted.join(', ')}.\n` +
        `Re-reconcile src/registry/ against the new upstream, then update\n` +
        `src/registry/UPSTREAM.json to the new hashes.`,
    );
    process.exit(1);
  }
}

// Guarded so the extraction and comparison helpers above can be imported from
// tests (vitest sets import.meta.main false) without executing a vendor run.
if (import.meta.main) {
  main();
}
