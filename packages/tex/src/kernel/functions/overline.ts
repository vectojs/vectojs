import defineFunction from "../../registry/defineFunction";
import {makeLineSpan, makeSpan, makeVList} from "../buildCommon";

import * as html from "../buildHTML";

defineFunction({
    type: "overline",
    names: ["\\overline"],
    numArgs: 1,

    handler({parser}, args) {
        const body = args[0];
        return {
            type: "overline",
            mode: parser.mode,
            body,
        };
    },

    htmlBuilder(group, options) {
        // Overlines are handled in the TeXbook pg 443, Rule 9.

        // Build the inner group in the cramped style.
        const innerGroup = html.buildGroup(group.body,
            options.havingCrampedStyle());

        // Create the line above the body
        const line = makeLineSpan("overline-line", options);

        // Generate the vlist, with the appropriate kerns
        const defaultRuleThickness = options.fontMetrics().defaultRuleThickness;
        const vlist = makeVList({
            positionType: "firstBaseline",
            children: [
                {type: "elem", elem: innerGroup},
                {type: "kern", size: 3 * defaultRuleThickness},
                {type: "elem", elem: line},
                {type: "kern", size: defaultRuleThickness},
            ],
        }, options);

        return makeSpan(["mord", "katex-overline"], [vlist], options);
    },
});
