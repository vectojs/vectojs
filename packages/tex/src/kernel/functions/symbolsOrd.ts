import {defineFunctionBuilders} from "../../registry/defineFunction";
import {makeOrd} from "../buildCommon";

import type {ParseNode} from "../types/nodes";

// "mathord" and "textord" ParseNodes created in Parser.js from symbol Groups in
// src/symbols.js.

const defaultVariant: Record<string, string> = {
    "mi": "italic",
    "mn": "normal",
    "mtext": "normal",
};

defineFunctionBuilders({
    type: "mathord",
    htmlBuilder(group, options) {
        return makeOrd(group, options);
    },
});

defineFunctionBuilders({
    type: "textord",
    htmlBuilder(group, options) {
        return makeOrd(group, options);
    },
});
