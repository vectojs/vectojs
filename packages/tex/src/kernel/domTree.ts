/**
 * These objects store the data about the DOM nodes we create, as well as some
 * extra data. They can then be transformed into real DOM nodes with the
 * `toNode` function or HTML markup using `toMarkup`. They are useful for both
 * storing extra properties on the nodes, as well as providing a way to easily
 * work with the DOM.
 *
 * Similar functions for working with MathML nodes exist in mathMLTree.js.
 *
 * TODO: refactor `span` and `anchor` into common superclass when
 * target environments support class inheritance
 */
import {scriptFromCodepoint} from "./unicodeScripts";
import {escape, hyphenate} from "./utils";
import {path} from "./svgGeometry";
import type Options from "./Options";
import {DocumentFragment} from "./tree";
import {makeEm} from "./units";
import ParseError from "./ParseError";

import type {VirtualNode} from "./tree";

/**
 * Create an HTML className based on a list of classes. In addition to joining
 * with spaces, we also remove empty classes.
 */
export const createClass = function(classes: string[]): string {
    return classes.filter(cls => cls).join(" ");
};

/**
 * Serialize a CssStyle object into a semicolon-delimited inline-style string
 * (hyphenating camelCase property names). Returns "" when no property is set.
 */
const cssStyleToString = function(style: CssStyle): string {
    let styles = "";
    for (const key of Object.keys(style) as Array<keyof CssStyle>) {
        const value = style[key];
        if (value !== undefined) {
            styles += `${hyphenate(key)}:${value};`;
        }
    }
    return styles;
};

type InitNodeData = {
    classes: string[];
    attributes: Record<string, string>;
    height: number;
    depth: number;
    maxFontSize: number;
    style: CssStyle;
};

type HtmlNodeData = InitNodeData & {
    children: VirtualNode[];
};

const initNode = function(
    this: InitNodeData,
    classes?: string[],
    options?: Options,
    style?: CssStyle,
) {
    this.classes = classes || [];
    this.attributes = {};
    this.height = 0;
    this.depth = 0;
    this.maxFontSize = 0;
    this.style = style || {};
    if (options) {
        if (options.style.isTight()) {
            this.classes.push("mtight");
        }
        const color = options.getColor();
        if (color) {
            this.style.color = color;
        }
    }
};

/**
 * https://w3c.github.io/html-reference/syntax.html#syntax-attributes
 *
 * > Attribute Names must consist of one or more characters
 * other than the space characters, U+0000 NULL,
 * '"', "'", ">", "/", "=", the control characters,
 * and any characters that are not defined by Unicode.
 */
const invalidAttributeNameRegex = /[\s"'>/=\x00-\x1f]/;

// Making the type below exact with all optional fields doesn't work due to
// - https://github.com/facebook/flow/issues/4582
// - https://github.com/facebook/flow/issues/5688
// However, since *all* fields are optional, $Shape<> works as suggested in 5688
// above.
// This type does not include all CSS properties. Additional properties should
// be added as needed.
export type CssStyle = Partial<{
    backgroundColor: string;
    borderBottomWidth: string;
    borderColor: string;
    borderRightStyle: string;
    borderRightWidth: string;
    borderTopWidth: string;
    borderStyle: string;
    borderWidth: string;
    bottom: string;
    color: string;
    height: string;
    left: string;
    margin: string;
    marginLeft: string;
    marginRight: string;
    marginTop: string;
    minWidth: string;
    paddingLeft: string;
    position: string;
    textShadow: string;
    top: string;
    width: string;
    verticalAlign: string;
}> & {};

export interface HtmlDomNode extends VirtualNode {
    classes: string[];
    height: number;
    depth: number;
    maxFontSize: number;
    style: CssStyle;
    hasClass(className: string): boolean;
}

// Span wrapping other DOM nodes.
export type DomSpan = Span<HtmlDomNode>;
// Span wrapping an SVG node.
export type SvgSpan = Span<SvgNode>;

export type SvgChildNode = PathNode | LineNode;
export type documentFragment = DocumentFragment<HtmlDomNode>;

/**
 * This node represents a span node, with a className, a list of children, and
 * an inline style. It also contains information about its height, depth, and
 * maxFontSize.
 *
 * Represents two types with different uses: SvgSpan to wrap an SVG and DomSpan
 * otherwise. This typesafety is important when HTML builders access a span's
 * children.
 */
export class Span<ChildType extends VirtualNode> implements HtmlDomNode {
    children: ChildType[];
    attributes!: Record<string, string>;
    classes!: string[];
    height!: number;
    depth!: number;
    width: number | null | undefined;
    maxFontSize!: number;
    style!: CssStyle;
    /**
     * Italic correction carried over from a SymbolNode when the symbol is
     * wrapped in a vlist (e.g. \oiint / \oiiint).  Read by supsub to adjust
     * subscript positioning.  Only set when nonzero; use `?? 0` at read sites.
     */
    italic?: number;

    constructor(
        classes?: string[],
        children?: ChildType[],
        options?: Options,
        style?: CssStyle,
    ) {
        initNode.call(this, classes, options, style);
        this.children = children || [];
    }

    /**
     * Sets an arbitrary attribute on the span. Warning: use this wisely. Not
     * all browsers support attributes the same, and having too many custom
     * attributes is probably bad.
     */
    setAttribute(attribute: string, value: string) {
        this.attributes[attribute] = value;
    }

    hasClass(className: string): boolean {
        return this.classes.includes(className);
    }
}

/**
 * This node represents an anchor (<a>) element with a hyperlink.  See `span`
 * for further details.
 */
export class Anchor implements HtmlDomNode {
    children: HtmlDomNode[];
    attributes!: Record<string, string>;
    classes!: string[];
    height!: number;
    depth!: number;
    maxFontSize!: number;
    style!: CssStyle;

    constructor(
        href: string,
        classes: string[],
        children: HtmlDomNode[],
        options: Options,
    ) {
        initNode.call(this, classes, options);
        this.children = children || [];
        this.setAttribute('href', href);
    }

    setAttribute(attribute: string, value: string) {
        this.attributes[attribute] = value;
    }

    hasClass(className: string): boolean {
        return this.classes.includes(className);
    }
}

/**
 * This node represents an image embed (<img>) element.
 */
export class Img implements VirtualNode {
    src: string;
    alt: string;
    classes: string[];
    height: number;
    depth: number;
    maxFontSize: number;
    style: CssStyle;

    constructor(
        src: string,
        alt: string,
        style: CssStyle,
    ) {
        this.alt = alt;
        this.src = src;
        this.classes = ["mord"];
        this.height = 0;
        this.depth = 0;
        this.maxFontSize = 0;
        this.style = style;
    }

    hasClass(className: string): boolean {
        return this.classes.includes(className);
    }
}

const iCombinations: Record<string, string> = {
    'î': '\u0131\u0302',
    'ï': '\u0131\u0308',
    'í': '\u0131\u0301',
    // 'ī': '\u0131\u0304', // enable when we add Extended Latin
    'ì': '\u0131\u0300',
};

/**
 * A symbol node contains information about a single symbol. It either renders
 * to a single text node, or a span with a single text node in it, depending on
 * whether it has CSS classes, styles, or needs italic correction.
 */
export class SymbolNode implements HtmlDomNode {
    text: string;
    height: number;
    depth: number;
    italic: number;
    skew: number;
    width: number;
    maxFontSize: number;
    classes: string[];
    style: CssStyle;

    constructor(
        text: string,
        height?: number,
        depth?: number,
        italic?: number,
        skew?: number,
        width?: number,
        classes?: string[],
        style?: CssStyle,
    ) {
        this.text = text;
        this.height = height || 0;
        this.depth = depth || 0;
        this.italic = italic || 0;
        this.skew = skew || 0;
        this.width = width || 0;
        this.classes = classes || [];
        this.style = style || {};
        this.maxFontSize = 0;

        // Mark text from non-Latin scripts with specific classes so that we
        // can specify which fonts to use.  This allows us to render these
        // characters with a serif font in situations where the browser would
        // either default to a sans serif or render a placeholder character.
        // We use CSS class names like cjk_fallback, hangul_fallback and
        // brahmic_fallback. See ./unicodeScripts.js for the set of possible
        // script names
        const script = scriptFromCodepoint(this.text.charCodeAt(0));
        if (script) {
            this.classes.push(script + "_fallback");
        }

        if (/[îïíì]/.test(this.text)) {    // add ī when we add Extended Latin
            this.text = iCombinations[this.text];
        }
    }

    hasClass(className: string): boolean {
        return this.classes.includes(className);
    }
}

/**
 * SVG nodes are used to render stretchy wide elements.
 */
export class SvgNode implements VirtualNode {
    children: SvgChildNode[];
    attributes: Record<string, string>;

    constructor(
        children?: SvgChildNode[],
        attributes?: Record<string, string>,
    ) {
        this.children = children || [];
        this.attributes = attributes || {};
    }
}

export class PathNode implements VirtualNode {
    pathName: string;
    alternate: string | null | undefined;

    constructor(pathName: string, alternate?: string) {
        this.pathName = pathName;
        this.alternate = alternate;  // Used only for \sqrt, \phase, & tall delims
    }
}

export class LineNode implements VirtualNode {
    attributes: Record<string, string>;

    constructor(
        attributes?: Record<string, string>,
    ) {
        this.attributes = attributes || {};
    }
}

export function assertSymbolDomNode(
    group: HtmlDomNode,
): SymbolNode {
    if (group instanceof SymbolNode) {
        return group;
    } else {
        throw new Error(`Expected symbolNode but got ${String(group)}.`);
    }
}

export function assertSpan(
    group: HtmlDomNode,
): Span<HtmlDomNode> {
    if (group instanceof Span) {
        return group;
    } else {
        throw new Error(`Expected span<HtmlDomNode> but got ${String(group)}.`);
    }
}

/**
 * Whether an HtmlDomNode has HtmlDomNode children.
 * HtmlDomNode is a base type representing a union of
 * SymbolNode, SvgSpan, DomSpan, Anchor, and documentFragment.
 * In the last three cases, the children are HtmlDomNode[].
 */
export const hasHtmlDomChildren = (
    node: HtmlDomNode,
): node is DomSpan | Anchor | documentFragment =>
    node instanceof Span ||
    node instanceof Anchor ||
    node instanceof DocumentFragment;
