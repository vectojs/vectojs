import defineFunction from "../../registry/defineFunction";
import {makeLineSpan, makeSpan, makeVList} from "../buildCommon";

import * as html from "../buildHTML";

defineFunction({
    type: "underline",
    names: ["\\underline"],
    numArgs: 1,
    allowedInText: true,

    handler({parser}, args) {
        return {
            type: "underline",
            mode: parser.mode,
            body: args[0],
        };
    },

    htmlBuilder(group, options) {
        // Underlines are handled in the TeXbook pg 443, Rule 10.
        // Build the inner group.
        const innerGroup = html.buildGroup(group.body, options);

        // Create the line to go below the body
        const line = makeLineSpan("underline-line", options);

        // Generate the vlist, with the appropriate kerns
        const defaultRuleThickness = options.fontMetrics().defaultRuleThickness;
        const vlist = makeVList({
            positionType: "top",
            positionData: innerGroup.height,
            children: [
                {type: "kern", size: defaultRuleThickness},
                {type: "elem", elem: line},
                {type: "kern", size: 3 * defaultRuleThickness},
                {type: "elem", elem: innerGroup},
            ],
        }, options);

        return makeSpan(["mord", "katex-underline"], [vlist], options);
    },
});
