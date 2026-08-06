import {defineFunctionBuilders} from "../../registry/defineFunction";
import {makeFragment, makeSpan} from "../buildCommon";

import * as html from "../buildHTML";

defineFunctionBuilders({
    type: "ordgroup",
    htmlBuilder(group, options) {
        if (group.semisimple) {
            return makeFragment(
                html.buildExpression(group.body, options, false));
        }
        return makeSpan(
            ["mord"], html.buildExpression(group.body, options, true), options);
    },
});
