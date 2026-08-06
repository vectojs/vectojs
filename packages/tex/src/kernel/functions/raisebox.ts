import defineFunction from "../../registry/defineFunction";
import {makeVList} from "../buildCommon";
import {assertNodeType} from "../parseNode";
import {calculateSize} from "../units";

import * as html from "../buildHTML";

// Box manipulation
defineFunction({
    type: "raisebox",
    names: ["\\raisebox"],
    numArgs: 2,
    argTypes: ["size", "hbox"],
    allowedInText: true,

    handler({parser}, args) {
        const amount = assertNodeType(args[0], "size").value;
        const body = args[1];
        return {
            type: "raisebox",
            mode: parser.mode,
            dy: amount,
            body,
        };
    },

    htmlBuilder(group, options) {
        const body = html.buildGroup(group.body, options);
        const dy = calculateSize(group.dy, options);
        return makeVList({
            positionType: "shift",
            positionData: -dy,
            children: [{type: "elem", elem: body}],
        }, options);
    },
});
