/**
 * The environment registry: how `\begin{…}` … `\end{…}` binds to a handler and a
 * layout builder.
 *
 * Hand-written replacement for KaTeX's `src/defineEnvironment.ts` (MIT), for the
 * same reason as its sibling `defineFunction.ts`: it assigns `mathmlBuilder` into a
 * second registry inside an `if`, which a token-level codemod cannot excise without
 * rewriting control flow. See that file's header for the full rationale.
 *
 * `scripts/vendor-katex.ts` hashes the upstream original into `UPSTREAM.json` and
 * fails the vendor run when it changes.
 *
 * Upstream: https://github.com/KaTeX/KaTeX/blob/main/src/defineEnvironment.ts
 */

import type { AnyParseNode, NodeType } from '../kernel/types/nodes';
import type { ArgType, Mode } from '../kernel/types';
import type Parser from '../kernel/Parser';
import { _htmlGroupBuilders, noteDuplicateRegistration, type HtmlBuilder } from './defineFunction';

/**
 * Parse-time context handed to an environment handler.
 */
type EnvContext = {
  /** Current parsing mode. */
  mode: Mode;
  /** The name of the environment, one of those registered. */
  envName: string;
  parser: Parser;
};

/**
 * An environment handler.
 *
 * `args` are the arguments passed to `\begin{name}`; `optArgs` its optional
 * arguments.
 */
type EnvHandler = (
  context: EnvContext,
  args: AnyParseNode[],
  optArgs: (AnyParseNode | null | undefined)[],
) => AnyParseNode;

/**
 * Parse-time properties controlling how the environment is read.
 *
 * Upstream's `EnvProps` declares only `numArgs`, and its `defineEnvironment`
 * pins the rest to hardcoded defaults — so a future KaTeX that starts passing
 * `argTypes` or `numOptionalArgs` for an environment would have those fields
 * silently dropped here. They are accepted and passed through instead, with
 * upstream's documented defaults, so a version bump surfaces new fields in
 * `_environments` rather than losing them (issue #611).
 */
type EnvProps = {
  /** Number of arguments following `\begin{name}`. (default 0) */
  numArgs: number;
  /**
   * The type of argument to parse in each position, optional arguments first,
   * mirroring `FunctionSpec.argTypes`. (default undefined)
   */
  argTypes?: ArgType[];
  /** Whether the environment is allowed inside text mode. (default false) */
  allowedInText?: boolean;
  /** How many optional arguments to parse. (default 0) */
  numOptionalArgs?: number;
};

/**
 * The environment spec used at parse time — the definition spec plus its handler,
 * with defaults resolved. Produced by {@link defineEnvironment}.
 */
export type EnvSpec<NODETYPE extends NodeType> = {
  type: NODETYPE;
  numArgs: number;
  argTypes?: ArgType[];
  allowedInText: boolean;
  numOptionalArgs: number;
  handler: EnvHandler;
};

/**
 * All registered environments. `environments.ts` re-exports this and `Parser`
 * reads it through that module.
 */
export const _environments: Record<string, EnvSpec<NodeType>> = {};

/**
 * Registration spec.
 *
 * Upstream also requires `mathmlBuilder`. It is absent by design — VectoJS emits
 * SVG and the MathML layer is not vendored.
 */
type EnvDefSpec<NODETYPE extends NodeType> = {
  /** Unique string differentiating parse nodes. */
  type: NODETYPE;

  /** Every name sharing this handler and builder. */
  names: string[];

  /** Properties controlling how the environment is parsed. */
  props: EnvProps;

  handler: EnvHandler;

  /** Returns the layout tree for the environment. */
  htmlBuilder: HtmlBuilder<NODETYPE>;
};

export default function defineEnvironment<NODETYPE extends NodeType>({
  type,
  names,
  props,
  handler,
  htmlBuilder,
}: EnvDefSpec<NODETYPE>) {
  // Resolve every field explicitly, as upstream's `defineFunction` does for
  // its own spec: declared values pass through, undeclared ones get their
  // documented defaults. Rebuilding the literal (rather than spreading props)
  // keeps `_environments` entries shaped exactly like `EnvSpec`.
  const data = {
    type,
    numArgs: props.numArgs || 0,
    argTypes: props.argTypes,
    allowedInText: props.allowedInText ?? false,
    numOptionalArgs: props.numOptionalArgs ?? 0,
    handler,
  };
  for (let i = 0; i < names.length; ++i) {
    if (Object.prototype.hasOwnProperty.call(_environments, names[i])) {
      noteDuplicateRegistration('environment', names[i]);
    }
    _environments[names[i]] = data;
  }
  if (htmlBuilder) {
    _htmlGroupBuilders[type] = htmlBuilder;
  }
}
