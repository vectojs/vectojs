import type {CssStyle, HtmlDomNode} from "./domTree";


// To ensure that all nodes have compatible signatures for these methods.
export interface VirtualNode {
}


/**
 * This node represents a document fragment, which contains elements, but when
 * placed into the DOM doesn't have any representation itself. It only contains
 * children and doesn't have any DOM node properties.
 */
export class DocumentFragment<ChildType extends VirtualNode>
    implements HtmlDomNode {
    children: ReadonlyArray<ChildType>;
    classes: string[];
    height: number;
    depth: number;
    maxFontSize: number;
    style: CssStyle;          // Never used; needed for satisfying interface.

    constructor(children: ReadonlyArray<ChildType>) {
        this.children = children;
        this.classes = [];
        this.height = 0;
        this.depth = 0;
        this.maxFontSize = 0;
        this.style = {};
    }

    hasClass(className: string): boolean {
        return this.classes.includes(className);
    }
}
