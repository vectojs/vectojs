import defineFunction, {ordargument} from "../../registry/defineFunction";
import {makeSpan} from "../buildCommon";
import {isCharacterBox} from "../utils";
import type {AnyParseNode, ParseNode} from "../types/nodes";

import * as html from "../buildHTML";

import type Options from "../Options";
import type {MathClass, Slice5} from "../types";

function htmlBuilder(group: ParseNode<"mclass">, options: Options) {
    const elements = html.buildExpression(group.body, options, true);
    return makeSpan([group.mclass], elements, options);
}

// Math class commands except \mathop
defineFunction({
    type: "mclass",
    names: [
        "\\mathord", "\\mathbin", "\\mathrel", "\\mathopen",
        "\\mathclose", "\\mathpunct", "\\mathinner",
    ],
    numArgs: 1,
    primitive: true,
    handler({parser, funcName}, args) {
        const body = args[0];
        return {
            type: "mclass",
            mode: parser.mode,
            mclass: `m${funcName.slice(5) as Slice5<typeof funcName>}`,
            body: ordargument(body),
            isCharacterBox: isCharacterBox(body),
        };
    },

    htmlBuilder,
});

export const binrelClass = (arg: AnyParseNode): MathClass => {
    // \binrel@ spacing varies with (bin|rel|ord) of the atom in the argument.
    // (by rendering separately and with {}s before and after, and measuring
    // the change in spacing).  We'll do roughly the same by detecting the
    // atom type directly.
    const atom = (arg.type === "ordgroup" && arg.body.length ? arg.body[0] : arg);
    if (atom.type === "atom" && (atom.family === "bin" || atom.family === "rel")) {
        return `m${atom.family}`;
    } else {
        return "mord";
    }
};

// \@binrel{x}{y} renders like y but as mbin/mrel/mord if x is mbin/mrel/mord.
// This is equivalent to \binrel@{x}\binrel@@{y} in AMSTeX.
defineFunction({
    type: "mclass",
    names: ["\\@binrel"],
    numArgs: 2,

    handler({parser}, args) {
        return {
            type: "mclass",
            mode: parser.mode,
            mclass: binrelClass(args[0]),
            body: ordargument(args[1]),
            isCharacterBox: isCharacterBox(args[1]),
        };
    },
});

// Build a relation or stacked op by placing one symbol on top of another
defineFunction({
    type: "mclass",
    names: ["\\stackrel", "\\overset", "\\underset"],
    numArgs: 2,

    handler({parser, funcName}, args) {
        const baseArg = args[1];
        const shiftedArg = args[0];

        let mclass: MathClass;
        if (funcName !== "\\stackrel") {
            // LaTeX applies \binrel spacing to \overset and \underset.
            mclass = binrelClass(baseArg);
        } else {
            mclass = "mrel";  // for \stackrel
        }

        const baseOp: ParseNode<"op"> = {
            type: "op",
            mode: baseArg.mode,
            limits: true,
            alwaysHandleSupSub: true,
            parentIsSupSub: false,
            symbol: false,
            suppressBaseShift: funcName !== "\\stackrel",
            body: ordargument(baseArg),
        };

        const supsub: ParseNode<"supsub"> = funcName === "\\underset"
            ? {type: "supsub", mode: shiftedArg.mode, base: baseOp, sub: shiftedArg}
            : {type: "supsub", mode: shiftedArg.mode, base: baseOp, sup: shiftedArg};

        return {
            type: "mclass",
            mode: parser.mode,
            mclass,
            body: [supsub],
            isCharacterBox: isCharacterBox(supsub),
        };
    },
});
