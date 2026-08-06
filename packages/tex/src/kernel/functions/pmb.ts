import defineFunction, {ordargument} from "../../registry/defineFunction";
import {makeSpan} from "../buildCommon";
import * as html from "../buildHTML";
import {binrelClass} from "./mclass";

import type {ParseNode} from "../types/nodes";

// \pmb is a simulation of bold font.
// The version of \pmb in ambsy.sty works by typesetting three copies
// with small offsets. We use CSS text-shadow.
// It's a hack. Not as good as a real bold font. Better than nothing.

defineFunction({
    type: "pmb",
    names: ["\\pmb"],
    numArgs: 1,
    allowedInText: true,

    handler({parser}, args) {
        return {
            type: "pmb",
            mode: parser.mode,
            mclass: binrelClass(args[0]),
            body: ordargument(args[0]),
        };
    },

    htmlBuilder(group: ParseNode<"pmb">, options) {
        const elements = html.buildExpression(group.body, options, true);
        const node = makeSpan([group.mclass], elements, options);
        node.style.textShadow = "0.02em 0.01em 0.04px";
        return node;
    },
});
