import type { TokenizerAndRendererExtension } from 'marked';

/**
 * GitHub-style emoji shortcodes: `:wink:` -> 😉.
 *
 * A new `marked.use` inline extension, the same shape as
 * `markdown-superscript.ts`'s `sup`: `:name:` is not tokenized by marked's
 * built-in grammar at all (verified against marked@18.0.7 — falls through to
 * plain `text`, `PX-0524`), so it needs its own tokenizer.
 *
 * Unlike `sup`/`ins`/`mark`, the token carries no NEW rendering behaviour —
 * once resolved, a shortcode is exactly a run of plain text (the emoji
 * character itself), which the browser's font stack already shapes and colors
 * via `fillText` like any other codepoint. So this module's only real content
 * is the lookup table; `collectSpans`' `emoji` arm just pushes the resolved
 * character with the inherited style, unchanged.
 *
 * Registered in `Markdown.ts` and `MarkdownWorker.ts` from this single shared
 * array, for the reason `markdown-footnote.ts` gives at length: the two lexers
 * must agree exactly, or the worker emits tokens the renderer has no arm for.
 *
 * Deliberately holds no entity, theme or `@vectojs/*` import, so this module
 * stays safe to inline into the worker bundle (`scripts/build-worker.js`,
 * `bundle: true`).
 */

/** `:name:`, as it appears mid-sentence, already resolved to its character. */
export interface EmojiToken {
  type: 'emoji';
  raw: string;
  /** The resolved emoji character(s), e.g. `'😉'` — never the shortcode text. */
  text: string;
}

/**
 * Shortcode -> emoji character, a representative common subset of GitHub's
 * table (github/gemoji), not the full ~1800-entry set. Extending this table
 * only ever adds a lookup entry; it never touches the tokenizer or
 * `collectSpans`, so growing it later is a one-line-per-emoji change.
 */
export const EMOJI_MAP: Readonly<Record<string, string>> = Object.freeze({
  // Smileys
  grinning: '😀',
  smiley: '😃',
  smile: '😄',
  grin: '😁',
  laughing: '😆',
  satisfied: '😆',
  sweat_smile: '😅',
  rofl: '🤣',
  joy: '😂',
  slightly_smiling_face: '🙂',
  upside_down_face: '🙃',
  wink: '😉',
  blush: '😊',
  innocent: '😇',
  heart_eyes: '😍',
  star_struck: '🤩',
  kissing_heart: '😘',
  yum: '😋',
  stuck_out_tongue: '😛',
  stuck_out_tongue_winking_eye: '😜',
  stuck_out_tongue_closed_eyes: '😝',
  hugs: '🤗',
  thinking: '🤔',
  neutral_face: '😐',
  expressionless: '😑',
  no_mouth: '😶',
  smirk: '😏',
  unamused: '😒',
  roll_eyes: '🙄',
  grimacing: '😬',
  relieved: '😌',
  pensive: '😔',
  sleepy: '😪',
  sleeping: '😴',
  mask: '😷',
  dizzy_face: '😵',
  sunglasses: '😎',
  nerd_face: '🤓',
  confused: '😕',
  worried: '😟',
  open_mouth: '😮',
  hushed: '😯',
  astonished: '😲',
  flushed: '😳',
  pleading_face: '🥺',
  fearful: '😨',
  cold_sweat: '😰',
  cry: '😢',
  sob: '😭',
  scream: '😱',
  disappointed: '😞',
  sweat: '😓',
  weary: '😩',
  tired_face: '😫',
  triumph: '😤',
  rage: '😡',
  angry: '😠',
  smiling_imp: '😈',
  imp: '👿',
  skull: '💀',
  clown_face: '🤡',
  poop: '💩',
  ghost: '👻',
  alien: '👽',
  robot: '🤖',

  // Gestures / body
  thumbsup: '👍',
  '+1': '👍',
  thumbsdown: '👎',
  '-1': '👎',
  punch: '👊',
  fist: '✊',
  clap: '👏',
  raised_hands: '🙌',
  open_hands: '👐',
  handshake: '🤝',
  pray: '🙏',
  muscle: '💪',
  eyes: '👀',
  wave: '👋',
  point_up: '☝️',
  point_down: '👇',
  point_left: '👈',
  point_right: '👉',
  ok_hand: '👌',
  v: '✌️',
  crossed_fingers: '🤞',

  // Hearts / symbols
  heart: '❤️',
  broken_heart: '💔',
  two_hearts: '💕',
  sparkling_heart: '💖',
  heartpulse: '💗',
  blue_heart: '💙',
  green_heart: '💚',
  yellow_heart: '💛',
  orange_heart: '🧡',
  purple_heart: '💜',
  black_heart: '🖤',
  white_heart: '🤍',
  100: '💯',
  boom: '💥',
  collision: '💥',
  dizzy: '💫',
  sweat_drops: '💦',
  dash: '💨',
  zzz: '💤',
  fire: '🔥',
  sparkles: '✨',
  star: '⭐',
  star2: '🌟',
  tada: '🎉',
  confetti_ball: '🎊',
  balloon: '🎈',
  gift: '🎁',
  rocket: '🚀',
  dart: '🎯',
  trophy: '🏆',
  warning: '⚠️',
  no_entry_sign: '🚫',
  white_check_mark: '✅',
  x: '❌',
  heavy_check_mark: '✔️',
  question: '❓',
  exclamation: '❗',
  bulb: '💡',
  bell: '🔔',

  // Tech / objects
  computer: '💻',
  iphone: '📱',
  link: '🔗',
  lock: '🔒',
  unlock: '🔓',
  key: '🔑',
  mag: '🔍',
  bug: '🐛',
  package: '📦',
  memo: '📝',
  pencil2: '✏️',
  book: '📖',
  books: '📚',
  pushpin: '📌',
  paperclip: '📎',
  calendar: '📅',
  file_folder: '📁',
  hammer: '🔨',
  wrench: '🔧',
  gear: '⚙️',
  chart_with_upwards_trend: '📈',
  chart_with_downwards_trend: '📉',
  bar_chart: '📊',
  construction: '🚧',
  hourglass: '⏳',
  stopwatch: '⏱️',

  // Food / nature / misc
  pizza: '🍕',
  coffee: '☕',
  beer: '🍺',
  cake: '🎂',
  birthday: '🎂',
  apple: '🍎',
  rainbow: '🌈',
  sun_with_face: '🌞',
  crescent_moon: '🌙',
  earth_americas: '🌎',
  dog: '🐶',
  cat: '🐱',
  fox_face: '🦊',
  bear: '🐻',
  panda_face: '🐼',
  monkey_face: '🐵',
  see_no_evil: '🙈',
  hear_no_evil: '🙉',
  speak_no_evil: '🙊',
});

/**
 * `:name:`: a colon, one or more shortcode characters (letters, digits,
 * underscore, `+`/`-` for `:+1:`/`:-1:`), then a closing colon.
 *
 * The content class is deliberately narrower than `SUP_RE`'s (which admits
 * almost anything): a shortcode is a fixed vocabulary, not free text. This
 * regex alone does NOT reject `10:30` or `a :) b` — `30` and `)` both fail
 * the allowed class, true, but a real rejection of "looks shortcode-shaped
 * but isn't a real one" (e.g. `:not_a_real_emoji:`, which DOES match this
 * regex) is the tokenizer's `EMOJI_MAP[match[1]] === undefined` check below,
 * not this pattern. Verified: loosening this class to `[^:]+` still passes
 * every discriminator test, because the lookup-table miss is the actual
 * backstop. This class exists to keep the match narrow and cheap (bounded
 * shortcode alphabet) and to avoid matching pathological runs of punctuation
 * as a shortcode candidate at all, not to distinguish emoticons or times.
 */
const EMOJI_RE = /^:([A-Za-z0-9_+-]+):/;

export const EMOJI_EXTENSIONS: TokenizerAndRendererExtension[] = [
  {
    name: 'emoji',
    level: 'inline',
    // Without `start()`, marked's plain-text fallback tokenizer (`inlineText`)
    // never stops at `:` — see `markdown-superscript.ts`'s identical note for
    // `^`, which applies here verbatim.
    start(src) {
      return src.match(/:/)?.index;
    },
    tokenizer(src) {
      const match = EMOJI_RE.exec(src);
      if (!match) return undefined;
      const resolved = EMOJI_MAP[match[1]];
      // An unknown shortcode (`:not_a_thing:`) is not a token at all — falling
      // through leaves it as literal text via `inlineText`, the same honest
      // fallback every unsupported construct in this package gets, rather than
      // silently swallowing an unrecognised `:name:` into nothing.
      if (resolved === undefined) return undefined;
      return {
        type: 'emoji',
        raw: match[0],
        text: resolved,
      } satisfies EmojiToken;
    },
    renderer(token) {
      return token.raw;
    },
  },
];
