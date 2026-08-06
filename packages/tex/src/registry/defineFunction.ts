/**
 * The function registry: how a TeX command binds to a parse handler and a layout
 * builder.
 *
 * Hand-written replacement for KaTeX's `src/defineFunction.ts` (MIT). It is **not**
 * produced by `scripts/vendor-katex.ts`, and the reason is specific: this is one of
 * only two files where `mathmlBuilder` appears in expression position rather than
 * as an object property. Upstream destructures it, tests it, and assigns it into a
 * second registry:
 *
 * ```ts
 * const {type, names, htmlBuilder, mathmlBuilder} = data;
 * if (mathmlBuilder) { _mathmlGroupBuilders[type] = mathmlBuilder; }
 * ```
 *
 * Deleting the identifier there leaves `if () {`. A token-level codemod cannot
 * repair that, because repairing it means understanding the control flow it sits
 * in — so this file is owned outright instead, and `_mathmlGroupBuilders` simply
 * does not exist.
 *
 * `scripts/vendor-katex.ts` hashes the upstream original into
 * `UPSTREAM.json` and fails the vendor run when it changes, so a KaTeX release that
 * alters the registry contract is reported rather than silently diverging from
 * the builders vendored around it.
 *
 * Upstream: https://github.com/KaTeX/KaTeX/blob/main/src/defineFunction.ts
 */

import type { HtmlDomNode } from '../kernel/domTree';
import type Options from '../kernel/Options';
import type Parser from '../kernel/Parser';
import type { Token } from '../kernel/Token';
import type { ArgType, BreakToken } from '../kernel/types';
import type {
  AnyParseNode,
  NodeType,
  ParseNode,
  UnsupportedCmdParseNode,
} from '../kernel/types/nodes';

/** Context provided to function handlers for error messages. */
export type FunctionContext<FUNCNAME extends string = string> = {
  funcName: FUNCNAME;
  parser: Parser;
  token?: Token;
  breakOnTokenText?: BreakToken;
};

export type FunctionHandler<NODETYPE extends NodeType, FUNCNAME extends string = string> = (
  context: FunctionContext<FUNCNAME>,
  args: AnyParseNode[],
  optArgs: (AnyParseNode | null)[],
) => UnsupportedCmdParseNode | ParseNode<NODETYPE>;

export type HtmlBuilder<NODETYPE extends NodeType> = (
  group: ParseNode<NODETYPE>,
  options: Options,
) => HtmlDomNode;

/**
 * A more general `HtmlBuilder` for nodes whose presence changes super/subscript
 * placement (`\sum`, accents). `ParseNode<"supsub">` delegates its own building to
 * the builder registered for these.
 */
export type HtmlBuilderSupSub<NODETYPE extends NodeType> = (
  group: ParseNode<'supsub'> | ParseNode<NODETYPE>,
  options: Options,
) => HtmlDomNode;

/**
 * Parser-facing function spec. Optional properties use the documented defaults.
 */
export type FunctionSpec<NODETYPE extends NodeType, FUNCNAME extends string = string> = {
  /**
   * Unique string differentiating parse nodes. Also fixes the type of the value
   * returned by `handler`.
   */
  type: NODETYPE;

  /** The number of arguments the function takes. */
  numArgs: number;

  /**
   * The type of argument to parse in each position. Length should equal
   * `numOptionalArgs + numArgs`, optional argument types first.
   */
  argTypes?: ArgType[];

  /**
   * Whether it expands to a single token or a braced group of tokens. A grouped
   * expansion may be used as an argument to a primitive such as `\sqrt` (without
   * its optional argument) or a super/subscript. (default false)
   */
  allowedInArgument?: boolean;

  /** Whether the function is allowed in text mode. (default false) */
  allowedInText?: boolean;

  /** Whether the function is allowed in math mode. (default true) */
  allowedInMath?: boolean;

  /**
   * How many optional arguments to parse. When an optional argument is absent,
   * `null` is passed to the handler in its place. (default 0)
   */
  numOptionalArgs?: number;

  /** Must be true if the function is an infix operator. */
  infix?: boolean;

  /** Whether the function is a TeX primitive. */
  primitive?: boolean;

  /**
   * Called to handle the function and its arguments, returning a `ParseNode`.
   * Required unless the parser handles the command directly.
   */
  handler: FunctionHandler<NODETYPE, FUNCNAME> | null | undefined;
};

/**
 * Builder fields consumed at registration and stored in `_htmlGroupBuilders`.
 *
 * Upstream also carries `mathmlBuilder` here. It is absent by design: VectoJS
 * emits SVG, and the MathML builders were the single largest removable mass in the
 * kernel — they are values inside object literals passed to a function, so no
 * bundler can prove them unreachable and they would ship as dead weight.
 */
export type FunctionBuilders<NODETYPE extends NodeType> = {
  /**
   * Returns the layout tree for the command. Must not mutate the `ParseNode`.
   */
  htmlBuilder?: HtmlBuilder<NODETYPE>;
};

/** Full registration spec passed to `defineFunction`. */
type FunctionDefSpec<NODETYPE extends NodeType, NAMES extends readonly string[]> = FunctionSpec<
  NODETYPE,
  NAMES[number]
> &
  FunctionBuilders<NODETYPE> & {
    /**
     * One name or a list of names. Every name listed shares this implementation.
     */
    names: NAMES;
  };

/**
 * All registered functions. `functions.ts` re-exports this and `Parser` reads it.
 */
export const _functions: Record<string, FunctionSpec<NodeType>> = {};

/**
 * All layout builders, keyed by parse-node type.
 *
 * Builders for different node types sit side by side, but `HtmlBuilder<T>` is
 * contravariant in `T`, so no single type argument makes storing and retrieving
 * them both typecheck. `any` is the existential-quantifier escape hatch, as
 * upstream.
 */
// oxlint-disable-next-line no-explicit-any
export const _htmlGroupBuilders: Record<string, HtmlBuilder<any>> = {};

export default function defineFunction<
  NODETYPE extends NodeType,
  const NAMES extends readonly string[],
>(data: FunctionDefSpec<NODETYPE, NAMES>) {
  const { type, names, htmlBuilder } = data;
  for (let i = 0; i < names.length; ++i) {
    // The entire spec is stored rather than a rebuilt subset, to avoid
    // destructuring and reallocating for every one of several hundred names.
    _functions[names[i]] = data;
  }
  if (type && htmlBuilder) {
    _htmlGroupBuilders[type] = htmlBuilder;
  }
}

/**
 * Registers only the builder for a function whose `ParseNode` is produced inside
 * `Parser` rather than by a standalone handler.
 */
export function defineFunctionBuilders<NODETYPE extends NodeType>({
  type,
  htmlBuilder,
}: {
  type: NODETYPE;
  htmlBuilder?: HtmlBuilder<NODETYPE>;
}) {
  if (htmlBuilder) {
    _htmlGroupBuilders[type] = htmlBuilder;
  }
}

export const normalizeArgument = function (arg: AnyParseNode): AnyParseNode {
  return arg.type === 'ordgroup' && arg.body.length === 1 ? arg.body[0] : arg;
};

/**
 * Normalizes an argument to the node list a builder expects, since a builder is
 * always handed a list.
 */
export const ordargument = function (arg: AnyParseNode): AnyParseNode[] {
  return arg.type === 'ordgroup' ? arg.body : [arg];
};
