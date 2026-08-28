/**
 * Adversarial corpus for incrementalLex.
 *
 * Each entry exercises one construct whose streaming behaviour is subtle:
 * - reference definition: degrades (link-definition)
 * - nested lists: stable after blank line + non-list token
 * - blockquote: nested bq
 * - table growth: single token that grows per row until closed
 * - fence: fenced code, open vs closed
 * - math ($$, cases): blockMath with blank-line guard, paragraphPairCap
 * - footnote: footnoteDef with continuation scan (footnote-def)
 * - container: ::: fence (container)
 * - CJK: Chinese/Japanese/Korean prose with inline markup
 * - RTL: Arabic/Hebrew (BiDi, not degraded)
 * - emoji: emoji sequences with markdown
 *
 * All docs are >4k chars so the stable-boundary ratio is meaningful
 * and the incremental vs wholeDocument delta is visible.
 */

export const ADVERSARIAL_CORPUS: Record<string, string> = {
  // Reference definitions: any `def` retroactively changes inline tokens
  // and forces permanent degraded mode. This doc has definitions both early
  // and late, so the degrader is hit early in the stream.
  'ref-definition': (() => {
    let out = '# References\n\n';
    out += '[alpha]: https://example.com/alpha "Alpha"\n';
    out += '[beta]: https://example.com/beta\n';
    out += '[gamma]: https://example.com/gamma\n\n';
    for (let i = 0; i < 40; i++) {
      out += `Paragraph ${i} using [alpha] and [beta] with **bold** and \`code\`.\n\n`;
      out += `See also [gamma] in context ${i}.\n\n`;
      if (i === 20) out += '[delta]: https://example.com/delta\n\n';
      if (i > 20) out += `Late paragraph ${i} uses [delta] after it was defined.\n\n`;
    }
    return out;
  })(),

  // Nested lists: 4-level nesting, alternating tight/loose, ordered/bullet
  // Task lists included. The list tokenizer absorbs following indented blocks,
  // so the stable cut must respect the one-token lag and list-settled check.
  'nested-lists': (() => {
    let out = '# Nested Lists\n\nIntro paragraph.\n\n';
    for (let block = 0; block < 25; block++) {
      out += `- Level 1 item ${block}.0\n`;
      out += `  - Level 2 item ${block}.0\n`;
      out += `    - Level 3 item ${block}.0\n`;
      out += `      - Level 4 item ${block}.0\n`;
      out += `    - Level 3 item ${block}.1 with **bold**\n`;
      out += `  - Level 2 item ${block}.1\n`;
      out += `- Level 1 item ${block}.1\n\n`;
      out += `1. Ordered ${block}.0\n`;
      out += `2. Ordered ${block}.1\n`;
      out += `   1. Nested ordered ${block}.0\n`;
      out += `   2. Nested ordered ${block}.1\n\n`;
      out += `- [ ] Task ${block}.0\n`;
      out += `- [x] Task ${block}.1\n\n`;
    }
    out += 'After lists.\n';
    return out;
  })(),

  // Blockquote: nested outer> inner, with headings, fences and blank lines
  blockquote: (() => {
    let out = '# Blockquotes\n\nIntro.\n\n';
    for (let i = 0; i < 30; i++) {
      out += `> Outer quote ${i} line one\n`;
      out += `> continued ${i}\n`;
      out += `> > Inner nested ${i}\n`;
      out += `> > more inner ${i}\n`;
      out += `> > ## Heading inside bq ${i}\n`;
      out += `> \n`;
      out += `> \`\`\`js\n`;
      out += `> const x${i} = ${i};\n`;
      out += `> \`\`\`\n\n`;
      out += `Body paragraph ${i} between quotes.\n\n`;
      if (i % 5 === 0) out += `> Single line quote ${i}\n\n`;
    }
    return out;
  })(),

  // Table growth: header + delimiter then 120 rows of 4 columns.
  // A table is ONE blockMath-like token that grows per row; the boundary
  // must not land inside it until the blank line after it.
  'table-growth': (() => {
    let out = '# Large Table\n\nIntro paragraph before table.\n\n';
    out += '| Col A | Col B | Col C | Col D |\n';
    out += '| --- | --- | --- | --- |\n';
    for (let r = 0; r < 120; r++) {
      out += `| r${r}c1 with **bold** | value ${r}.2 | note ${r} | [link](https://example.com/${r}) |\n`;
    }
    out += '\nAfter table paragraph with some more prose to establish a stable boundary.\n\n';
    for (let i = 0; i < 10; i++) out += `Trailing para ${i}.\n\n`;
    return out;
  })(),

  // Fence: many fenced code blocks with different langs, some containing
  // markdown-like text that must NOT be parsed as blocks inside the fence.
  fence: (() => {
    let out = '# Fenced Code\n\nIntro.\n\n';
    const langs = ['js', 'py', 'ts', 'md', 'rust', 'go'];
    for (let i = 0; i < 30; i++) {
      const lang = langs[i % langs.length]!;
      out += `\`\`\`${lang}\n`;
      out += `// block ${i}\n`;
      out += `const a${i} = ${i};\n`;
      out += `# This heading inside a fence must NOT become a heading token\n`;
      out += `- not a list\n`;
      out += `| not | a | table |\n`;
      out += `\`\`\`\n\n`;
      out += `Paragraph ${i} after fence.\n\n`;
    }
    // Include indented code as well
    out += '    indented code line one\n';
    out += '    indented code line two\n\n';
    out += 'After all fences.\n';
    return out;
  })(),

  // Math display $$, multiple blocks. No longer degrades after vectojs#394
  // but exercises paragraphPairCap and forward blank-line guard.
  'math-display': (() => {
    let out = '# Display Math\n\nIntro prose.\n\n';
    for (let i = 0; i < 25; i++) {
      out += `Paragraph ${i} introducing formula ${i} with **bold**.\n\n`;
      out += `$$\n\\sum_{k=0}^{${i}} a_k = \\frac{${i}}{2} + \\int_{0}^{1} x^{${i}} dx\n$$\n\n`;
      out += `Prose after formula ${i}.\n\n`;
    }
    return out;
  })(),

  // Math with cases environment (\\begin{cases}) – the text asked for `cases`
  // explicitly. This is the same blockMath tokenizer but with more complex
  // inner LaTeX that we want to ensure survives incremental lexing.
  'math-cases': (() => {
    let out = '# Math Cases\n\nIntro.\n\n';
    for (let i = 0; i < 20; i++) {
      out += `Paragraph ${i}.\n\n`;
      out += `$$\n f(x) = \\begin{cases} ${i} & x > 0 \\\\ 0 & x = 0 \\\\ -${i} & x < 0 \\end{cases}\n$$\n\n`;
      out += `After cases ${i}.\n\n`;
    }
    // Also inline math with cases-like text
    out += 'Inline cases $f(x)=\\begin{cases}1 & x>0\\end{cases}$ inside prose.\n\n';
    for (let i = 0; i < 10; i++) out += `Trailing para ${i}.\n\n`;
    return out;
  })(),

  // Footnote: definitions with multi-paragraph continuation (indented).
  // Now degraded via hasFootnoteDefOpener because the tokenizer scans forward
  // across blank lines for indented continuation.
  footnote: (() => {
    let out = '# Footnotes\n\nIntro with refs [^1] and [^long].\n\n';
    for (let i = 0; i < 20; i++) {
      out += `Paragraph ${i} referencing [^${i % 5}] and [^note${i}].\n\n`;
    }
    out += '[^1]: First footnote, single line.\n\n';
    out += '[^long]: This is a multi-paragraph footnote.\n\n';
    out += '    Second paragraph of the footnote, indented by four spaces.\n\n';
    out += '    Third paragraph as well.\n\n';
    for (let i = 2; i < 10; i++) {
      out += `[^${i}]: Footnote ${i} body text with **bold** and [link](https://example.com/${i}).\n\n`;
    }
    out += '[^note]: Another definition.\n\n';
    out += 'After footnotes, prose continues.\n\n';
    for (let i = 0; i < 10; i++) out += `Tail para ${i}.\n\n`;
    return out;
  })(),

  // Container: ::: fences, nested, with markdown inside.
  // Degrades via hasContainerOpener because an unterminated ::: can absorb
  // arbitrarily much following text.
  container: (() => {
    let out = '# Containers\n\nIntro.\n\n';
    for (let i = 0; i < 25; i++) {
      out += `:::warning\n`;
      out += `Container ${i} body paragraph with **bold**.\n\n`;
      out += `- list inside container ${i}\n`;
      out += `- another item\n\n`;
      out += `:::note\n`;
      out += `Nested container ${i}\n`;
      out += `:::\n`;
      out += `:::\n\n`;
      out += `Paragraph ${i} after container.\n\n`;
    }
    return out;
  })(),

  // CJK: Chinese, Japanese, Korean with markdown constructs.
  // Not degraded – exercises that tight CJK + markup + inline math still works
  // and that offsets are byte-correct for multi-byte characters (charsLexed is
  // in JS string length, which counts UTF-16 code units, but raw lengths must
  // still tile the source).
  CJK: (() => {
    let out = '# 中文标题\n\n';
    out += '这是中文段落，包含**粗体**和`代码`以及[链接](https://example.com)。\n\n';
    out += '## 日本語セクション 1\n\n';
    out += '日本語の段落です。**太字**と`インラインコード`と[MathJax](https://example.com)。\n\n';
    out += '### 한국어 섹션\n\n';
    out += '한국어 단락입니다. **굵게**와 `코드`를 포함합니다.\n\n';
    for (let i = 0; i < 30; i++) {
      out += `## 段落 ${i}\n\n`;
      out += `这是第 ${i} 段中文，包含 **加粗 ${i}** 和 \`代码${i}\`。\n\n`;
      out += `日本語の段落 ${i} では、数式 $x_{${i}} + y_{${i}} = ${i}$ を含みます。\n\n`;
      out += `한국어 단락 ${i}: 값은 ${i * 2} 입니다.\n\n`;
      out += `- リスト項目 ${i}.0\n`;
      out += `- 列表项 ${i}.1\n`;
      out += `- 목록 항목 ${i}.2\n\n`;
      out += `| 列A | 列B |\n| --- | --- |\n| 値${i} | 값${i} |\n\n`;
    }
    // CJK tight markup edge case: **$x$** should be strong containing math, not broken
    out += 'CJK 紧贴 **$x+1$** 强测试。\n\n';
    out += '日本語で**$y^2$**をテスト。\n\n';
    out += '한국어에서 **$z$** 테스트.\n\n';
    return out;
  })(),

  // RTL: Arabic and Hebrew. Like CJK, this is inline BiDi – not degraded,
  // but the line/offset arithmetic must still hold for RTL runs.
  RTL: (() => {
    let out = '# مرحبا بالعالم\n\n';
    out += 'هذه فقرة عربية تحتوي على **نص عريض** و`كود` و[رابط](https://example.com)。\n\n';
    out += '## כותרת בעברית\n\n';
    out += 'פסקה בעברית עם **הדגשה** ו`קוד` ו[קישור](https://example.com).\n\n';
    for (let i = 0; i < 30; i++) {
      out += `## مقطع ${i}\n\n`;
      out += `فقرة عربية ${i} مع **نص ${i}** و \`كود${i}\`.\n\n`;
      out += `פסקה עברית ${i} עם **טקסט ${i}**.\n\n`;
      out += `- عنصر قائمة ${i}.0\n`;
      out += `- פריט רשימה ${i}.1\n\n`;
      out += `| عمود أ | עמודה ב |\n| --- | --- |\n| قيمة${i} | ערך${i} |\n\n`;
      // Mix LTR and RTL in one paragraph, as real content does
      out += `Mixed ${i}: Hello مرحبا שלום ${i} with **bold**.\n\n`;
    }
    // Inline math inside RTL paragraph
    out += 'معادلة $x + y = 1$ داخل النص العربي.\n\n';
    out += 'משוואה $a^2 + b^2 = c^2$ בתוך טקסט עברי.\n\n';
    return out;
  })(),

  // Emoji: emoji sequences, ZWJ, variation selectors, with markdown
  emoji: (() => {
    let out = '# Emoji 🎉\n\n';
    out += 'Intro with emoji 😀 😃 😄 and **bold 👍** and `code 💻`.\n\n';
    for (let i = 0; i < 30; i++) {
      out += `## Section ${i} 🚀\n\n`;
      out += `Paragraph ${i} with emoji family 👩‍👩‍👧‍👦 and flag 🇯🇵 and skin tone 👍🏽.\n\n`;
      out += `- item ${i} 🎈\n`;
      out += `- item ${i} with **bold ❤️**\n\n`;
      out += `Code \`emoji ${i} ✨\` and link [emoji](https://example.com/${i}) 🎯.\n\n`;
      out += `Table for ${i}:\n\n`;
      out += `| Emo | Desc |\n| --- | --- |\n| 😀 | grin ${i} |\n| ❤️ | heart ${i} |\n\n`;
    }
    // Emoji tight with markup
    out += 'Tight **😀** and `💻` and $x+😀$ math? No, emoji inside math is literal.\n\n';
    // Long emoji ZWJ sequence
    out += 'ZWJ: 👨‍💻 👩‍🔬 🧑‍🎤 and variation: ☝️ ✌️\n\n';
    return out;
  })(),
};
