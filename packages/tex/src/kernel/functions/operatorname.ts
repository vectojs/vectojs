import defineFunction, {ordargument} from "../../registry/defineFunction";
import defineMacro from "../defineMacro";
import {makeSpan} from "../buildCommon";
import {SymbolNode} from "../domTree";
import {assembleSupSub} from "./utils/assembleSupSub";
import {assertNodeType} from "../parseNode";

import * as html from "../buildHTML";

import type {HtmlBuilderSupSub} from "../../registry/defineFunction";
import type {AnyParseNode, ParseNode} from "../types/nodes";

// NOTE: Unlike most `htmlBuilder`s, this one handles not only
// "operatorname", but also  "supsub" since \operatorname* can
// affect super/subscripting.
export const htmlBuilder: HtmlBuilderSupSub<"operatorname"> = (grp, options) => {
    // Operators are handled in the TeXbook pg. 443-444, rule 13(a).
    let supGroup;
    let subGroup;
    let hasLimits = false;
    let group: ParseNode<"operatorname">;
    if (grp.type === "supsub") {
        // If we have limits, supsub will pass us its group to handle. Pull
        // out the superscript and subscript and set the group to the op in
        // its base.
        supGroup = grp.sup;
        subGroup = grp.sub;
        group = assertNodeType(grp.base, "operatorname");
        hasLimits = true;
    } else {
        group = assertNodeType(grp, "operatorname");
    }

    let base;
    if (group.body.length > 0) {
        const body = group.body.map((child): AnyParseNode => {
            const childText = "text" in child ? child.text : undefined;
            if (typeof childText === "string") {
                return {
                    type: "textord",
                    mode: child.mode,
                    text: childText,
                };
            } else {
                return child;
            }
        });

        // Consolidate function names into symbol characters.
        const expression = html.buildExpression(
            body, options.withFont("mathrm"), true);

        for (let i = 0; i < expression.length; i++) {
            const child = expression[i];
            if (child instanceof SymbolNode) {
                // Per amsopn package,
                // change minus to hyphen and \ast to asterisk
                child.text = child.text.replace(/\u2212/, "-")
                    .replace(/\u2217/, "*");
            }
        }
        base = makeSpan(["mop"], expression, options);
    } else {
        base = makeSpan(["mop"], [], options);
    }

    if (hasLimits) {
        return assembleSupSub(base, supGroup, subGroup, options,
            options.style, 0, 0);

    } else {
        return base;
    }
};

// \operatorname
// amsopn.dtx: \mathop{#1\kern\z@\operator@font#3}\newmcodes@
defineFunction({
    type: "operatorname",
    names: ["\\operatorname@", "\\operatornamewithlimits"],
    numArgs: 1,

    handler: ({parser, funcName}, args) => {
        const body = args[0];
        return {
            type: "operatorname",
            mode: parser.mode,
            body: ordargument(body),
            alwaysHandleSupSub: (funcName === "\\operatornamewithlimits"),
            limits: false,
            parentIsSupSub: false,
        };
    },

    htmlBuilder,
});

defineMacro("\\operatorname",
  "\\@ifstar\\operatornamewithlimits\\operatorname@");
