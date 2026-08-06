import defineFunction, {ordargument} from "../../registry/defineFunction";
import {makeFragment} from "../buildCommon";
import {assertNodeType} from "../parseNode";
import type {AnyParseNode} from "../types/nodes";
import type {HtmlBuilder} from "../../registry/defineFunction";

import * as html from "../buildHTML";

const htmlBuilder: HtmlBuilder<"color"> = (group, options) => {
    const elements = html.buildExpression(
        group.body,
        options.withColor(group.color),
        false
    );

    // \color isn't supposed to affect the type of the elements it contains.
    // To accomplish this, we wrap the results in a fragment, so the inner
    // elements will be able to directly interact with their neighbors. For
    // example, `\color{red}{2 +} 3` has the same spacing as `2 + 3`
    return makeFragment(elements);
};

defineFunction({
    type: "color",
    names: ["\\textcolor"],
    numArgs: 2,
    allowedInText: true,
    argTypes: ["color", "original"],

    handler({parser}, args) {
        const color = assertNodeType(args[0], "color-token").color;
        const body = args[1];
        return {
            type: "color",
            mode: parser.mode,
            color,
            body: (ordargument(body) as AnyParseNode[]),
        };
    },

    htmlBuilder,
});

defineFunction({
    type: "color",
    names: ["\\color"],
    numArgs: 1,
    allowedInText: true,
    argTypes: ["color"],

    handler({parser, breakOnTokenText}, args) {
        const color = assertNodeType(args[0], "color-token").color;

        // Set macro \current@color in current namespace to store the current
        // color, mimicking the behavior of color.sty.
        // This is currently used just to correctly color a \right
        // that follows a \color command.
        parser.gullet.macros.set("\\current@color", color);

        // Parse out the implicit body that should be colored.
        const body: AnyParseNode[] = parser.parseExpression(true, breakOnTokenText);

        return {
            type: "color",
            mode: parser.mode,
            color,
            body,
        };
    },
});
