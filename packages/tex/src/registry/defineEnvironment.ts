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
import { _htmlGroupBuilders, type HtmlBuilder } from './defineFunction';

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

/** Parse-time properties controlling how the environment is read. */
type EnvProps = {
  /** Number of arguments following `\begin{name}`. (default 0) */
  numArgs: number;
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
  const data = {
    type,
    numArgs: props.numArgs || 0,
    allowedInText: false,
    numOptionalArgs: 0,
    handler,
  };
  for (let i = 0; i < names.length; ++i) {
    _environments[names[i]] = data;
  }
  if (htmlBuilder) {
    _htmlGroupBuilders[type] = htmlBuilder;
  }
}
