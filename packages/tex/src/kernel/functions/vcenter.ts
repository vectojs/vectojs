import defineFunction from "../../registry/defineFunction";
import {makeVList} from "../buildCommon";

import * as html from "../buildHTML";

// \vcenter:  Vertically center the argument group on the math axis.

defineFunction({
    type: "vcenter",
    names: ["\\vcenter"],
    numArgs: 1,
    argTypes: ["original"], // In LaTeX, \vcenter can act only on a box.
    allowedInText: false,

    handler({parser}, args) {
        return {
            type: "vcenter",
            mode: parser.mode,
            body: args[0],
        };
    },

    htmlBuilder(group, options) {
        const body = html.buildGroup(group.body, options);
        const axisHeight = options.fontMetrics().axisHeight;
        const dy = 0.5 * ((body.height - axisHeight) - (body.depth + axisHeight));
        return makeVList({
            positionType: "shift",
            positionData: dy,
            children: [{type: "elem", elem: body}],
        }, options);
    },
});
