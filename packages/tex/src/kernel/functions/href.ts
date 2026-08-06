import defineFunction, {ordargument} from "../../registry/defineFunction";
import {makeAnchor} from "../buildCommon";
import {assertNodeType} from "../parseNode";

import * as html from "../buildHTML";
import type {ParseNode} from "../types/nodes";

defineFunction({
    type: "href",
    names: ["\\href"],
    numArgs: 2,
    argTypes: ["url", "original"],
    allowedInText: true,

    handler: ({parser}, args) => {
        const body = args[1];
        const href = assertNodeType(args[0], "url").url;

        if (!parser.settings.isTrusted({
            command: "\\href",
            url: href,
        })) {
            return parser.formatUnsupportedCmd("\\href");
        }

        return {
            type: "href",
            mode: parser.mode,
            href,
            body: ordargument(body),
        };
    },

    htmlBuilder: (group, options) => {
        const elements = html.buildExpression(group.body, options, false);
        return makeAnchor(group.href, [], elements, options);
    },
});

defineFunction({
    type: "href",
    names: ["\\url"],
    numArgs: 1,
    argTypes: ["url"],
    allowedInText: true,

    handler: ({parser}, args) => {
        const href = assertNodeType(args[0], "url").url;

        if (!parser.settings.isTrusted({
            command: "\\url",
            url: href,
        })) {
            return parser.formatUnsupportedCmd("\\url");
        }

        const chars: ParseNode<"textord">[] = [];
        for (let i = 0; i < href.length; i++) {
            let c = href[i];
            if (c === "~") {
                c = "\\textasciitilde";
            }
            chars.push({
                type: "textord",
                mode: "text",
                text: c,
            });
        }
        const body: ParseNode<"text"> = {
            type: "text",
            mode: parser.mode,
            font: "\\texttt",
            body: chars,
        };
        return {
            type: "href",
            mode: parser.mode,
            href,
            body: ordargument(body),
        };
    },
});
