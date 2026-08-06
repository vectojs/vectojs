import defineFunction from "../../registry/defineFunction";
import Style from "../Style";
import {sizingGroup} from "./sizing";
import type {StyleStr} from "../types";

const styleMap: Record<StyleStr, typeof Style.DISPLAY> = {
    "display": Style.DISPLAY,
    "text": Style.TEXT,
    "script": Style.SCRIPT,
    "scriptscript": Style.SCRIPTSCRIPT,
};

function isStyleStr(s: string): s is StyleStr {
    return s in styleMap;
}

defineFunction({
    type: "styling",
    names: [
        "\\displaystyle", "\\textstyle", "\\scriptstyle",
        "\\scriptscriptstyle",
    ],
    numArgs: 0,
    allowedInText: true,
    primitive: true,

    handler({breakOnTokenText, funcName, parser}, args) {
        // parse out the implicit body
        const body = parser.parseExpression(true, breakOnTokenText);

        // TODO: Refactor to avoid duplicating styleMap in multiple places (e.g.
        // here and in buildHTML and de-dupe the enumeration of all the styles).
        const style = funcName.slice(1, funcName.length - 5);
        if (!isStyleStr(style)) {
            throw new Error(`Unknown style: ${style}`);
        }
        return {
            type: "styling",
            mode: parser.mode,
            // Figure out what style to use by pulling out the style from
            // the function name
            style,
            body,
        };
    },

    htmlBuilder(group, options) {
        // Style changes are handled in the TeXbook on pg. 442, Rule 3.
        const newStyle = styleMap[group.style];
        let newOptions = options.havingStyle(newStyle);
        if (group.resetFont) {
            newOptions = newOptions.withFont('');
        }
        return sizingGroup(group.body, newOptions, options);
    },
});
