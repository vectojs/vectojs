import defineFunction, {ordargument} from "../../registry/defineFunction";
import defineMacro from "../defineMacro";
import {makeFragment, makeSpan} from "../buildCommon";

import * as html from "../buildHTML";

defineFunction({
    type: "phantom",
    names: ["\\phantom"],
    numArgs: 1,
    allowedInText: true,

    handler: ({parser}, args) => {
        const body = args[0];
        return {
            type: "phantom",
            mode: parser.mode,
            body: ordargument(body),
        };
    },

    htmlBuilder: (group, options) => {
        const elements = html.buildExpression(
            group.body,
            options.withPhantom(),
            false
        );

        // \phantom isn't supposed to affect the elements it contains.
        // See "color" for more details.
        return makeFragment(elements);
    },
});

defineMacro("\\hphantom", "\\smash{\\phantom{#1}}");

defineFunction({
    type: "vphantom",
    names: ["\\vphantom"],
    numArgs: 1,
    allowedInText: true,

    handler: ({parser}, args) => {
        const body = args[0];
        return {
            type: "vphantom",
            mode: parser.mode,
            body,
        };
    },

    htmlBuilder: (group, options) => {
        const inner = makeSpan(
            ["katex-inner"],
            [html.buildGroup(group.body, options.withPhantom())]);
        const fix = makeSpan(["katex-fix"], []);
        return makeSpan(
            ["mord", "rlap"], [inner, fix], options);
    },
});
