import {defineFunctionBuilders} from "../../registry/defineFunction";
import {mathsym} from "../buildCommon";

// Operator ParseNodes created in Parser.js from symbol Groups in src/symbols.js.

defineFunctionBuilders({
    type: "atom",
    htmlBuilder(group, options) {
        return mathsym(
            group.text, group.mode, options, ["m" + group.family]);
    },
});
