/**
 * Text units, terminal display width and word boundaries for the rewrite
 * editor.
 *
 * The editor's offsets are GRAPHEME CLUSTERS, not code points: a skin-tone
 * emoji, a ZWJ family, a combining accent or a keycap sequence edits as one
 * unit, the way the host's prompt editor treats them. Everything that maps
 * between offsets, display cells and input clicks must agree on that unit -
 * mixing code points, UTF-16 units and cells lets the caret land inside a
 * glyph and Backspace take half an emoji.
 *
 * Width follows the host's renderer (\`@deepseek-harness-tui/dsh-tui\`'s
 * \`ink/stringWidth.js\`) without importing it: East Asian Width with
 * \`ambiguousAsWide: false\`, plus the Emoji_Presentation / VS16 / ZWJ rules its
 * terminals actually paint. That module is not on the plugin surface, so the
 * rules are mirrored here; test-harness/test/scene.test.mjs pins them to the
 * examples the host gets right.
 *
 * Word boundaries use \`Intl.Segmenter\` with word granularity, again like the
 * host's \`utils/draftWordBoundary.js\`: a cheap hard-rule layer first (edges,
 * whitespace, CJK punctuation, script changes), then ICU (whose dictionary is
 * what makes CJK typing group into words). Offsets crossing that API are
 * cluster indices; the conversion to UTF-16 happens inside this module.
 *
 * @module dsh-tui-rewrite/text
 */

/** The host fixes the segmenter locale to 'en'; Han/kana results are identical. */
let graphemeSegmenter;
let wordSegmenter;

function graphemeSegmenterFor() {
  if (graphemeSegmenter === undefined && typeof Intl.Segmenter === 'function') {
    graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  }
  return graphemeSegmenter;
}

function wordSegmenterFor() {
  if (wordSegmenter === undefined && typeof Intl.Segmenter === 'function') {
    wordSegmenter = new Intl.Segmenter('en', { granularity: 'word' });
  }
  return wordSegmenter;
}

/**
 * Split a draft into grapheme clusters, with newlines kept as their own unit.
 *
 * Lines are segmented separately on purpose: a CRLF is one grapheme cluster,
 * but the editor's line model needs the '\\n' to be its own offset. Nothing
 * else spans a newline.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function units(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const segmenter = graphemeSegmenterFor();
  if (segmenter === undefined) return Array.from(text);
  const found = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) found.push('\n');
    if (lines[index] === '') continue;
    for (const part of segmenter.segment(lines[index])) found.push(part.segment);
  }
  return found;
}

/**
 * East Asian Width = Wide/Fullwidth ranges (\`eastAsianWidth\` with
 * \`ambiguousAsWide: false\`, generated from the host dependency's Unicode
 * data). Ambiguous characters count as one cell.
 */
const WIDE_RANGES = [
  [4352, 4447], [8986, 8987], [9001, 9002], [9193, 9196], [9200, 9200], [9203, 9203],
  [9725, 9726], [9748, 9749], [9776, 9783], [9800, 9811], [9855, 9855], [9866, 9871],
  [9875, 9875], [9889, 9889], [9898, 9899], [9917, 9918], [9924, 9925], [9934, 9934],
  [9940, 9940], [9962, 9962], [9970, 9971], [9973, 9973], [9978, 9978], [9981, 9981],
  [9989, 9989], [9994, 9995], [10024, 10024], [10060, 10060], [10062, 10062],
  [10067, 10069], [10071, 10071], [10133, 10135], [10160, 10160], [10175, 10175],
  [11035, 11036], [11088, 11088], [11093, 11093], [11904, 11929], [11931, 12019],
  [12032, 12245], [12272, 12350], [12353, 12438], [12441, 12543], [12549, 12591],
  [12593, 12686], [12688, 12773], [12783, 12830], [12832, 12871], [12880, 42124],
  [42128, 42182], [43360, 43388], [44032, 55203], [63744, 64255], [65040, 65049],
  [65072, 65106], [65108, 65126], [65128, 65131], [65281, 65376], [65504, 65510],
  [94176, 94180], [94192, 94198], [94208, 101594], [101631, 101664], [101760, 101874],
  [101888, 102801], [102816, 102866], [110576, 110579], [110581, 110587], [110589, 110590],
  [110592, 110888], [110898, 110898], [110928, 110930], [110933, 110933],
  [110948, 110952], [110960, 111355], [119552, 119638], [119648, 119670],
  [126980, 126980], [127183, 127183], [127374, 127374], [127377, 127386],
  [127406, 127406], [127488, 127490], [127504, 127547], [127552, 127560],
  [127568, 127569], [127584, 127589], [127744, 127776], [127789, 127797],
  [127799, 127868], [127870, 127891], [127904, 127946], [127951, 127955],
  [127968, 127984], [127988, 127988], [127992, 128062], [128064, 128064],
  [128066, 128252], [128255, 128317], [128331, 128334], [128336, 128359],
  [128378, 128378], [128405, 128406], [128420, 128420], [128507, 128591],
  [128640, 128709], [128716, 128716], [128720, 128722], [128725, 128729],
  [128732, 128735], [128747, 128748], [128756, 128764], [128986, 128986],
  [128992, 129003], [129008, 129008], [129292, 129338], [129340, 129349],
  [129351, 129535], [129648, 129660], [129664, 129734], [129736, 129736],
  [129740, 129757], [129759, 129771], [129775, 129786], [131072, 196605],
  [196608, 262141],
];

/** Emoji_Presentation=Yes, merged and sorted (Unicode emoji-data.txt). */
const EMOJI_PRESENTATION_RANGES = [
  [0x231a, 0x231b], [0x23e9, 0x23ec], 0x23f0, 0x23f3, [0x25fd, 0x25fe],
  [0x2614, 0x2615], [0x2648, 0x2653], 0x267f, 0x2693, 0x26a1,
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], 0x26ce, 0x26d4,
  0x26ea, [0x26f2, 0x26f3], 0x26f5, 0x26fa, 0x26fd, 0x2705,
  [0x270a, 0x270b], 0x2728, 0x274c, 0x274e, [0x2753, 0x2755], 0x2757,
  [0x2795, 0x2797], 0x27b0, 0x27bf, [0x2b1b, 0x2b1c], 0x2b50, 0x2b55,
  0x1f004, 0x1f0cf, 0x1f18e, [0x1f191, 0x1f19a], [0x1f1e6, 0x1f1ff],
  0x1f201, 0x1f21a, 0x1f22f, [0x1f232, 0x1f236], [0x1f238, 0x1f23a],
  [0x1f250, 0x1f251], [0x1f300, 0x1f320], [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c], [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0], 0x1f3f4, [0x1f3f8, 0x1f43e],
  0x1f440, [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567], 0x1f57a, [0x1f595, 0x1f596], 0x1f5a4,
  [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5], 0x1f6cc, [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d8], [0x1f6dc, 0x1f6df], [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb], 0x1f7f0, [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff], [0x1fa70, 0x1fa7c],
  [0x1fa80, 0x1fa8a], [0x1fa8e, 0x1fac6], 0x1fac8, [0x1facd, 0x1fadc],
  [0x1fadf, 0x1faea], [0x1faef, 0x1faf8],
];

/** Binary search over the sorted ranges (numbers are single code points). */
function inRanges(codePoint, ranges) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = ranges[mid];
    const start = typeof entry === 'number' ? entry : entry[0];
    const end = typeof entry === 'number' ? entry : entry[1];
    if (codePoint < start) hi = mid - 1;
    else if (codePoint > end) lo = mid + 1;
    else return true;
  }
  return false;
}

function isEmojiPresentation(codePoint) {
  return inRanges(codePoint, EMOJI_PRESENTATION_RANGES);
}

/** Zero-width/invisible code points, matching the host renderer's rules. */
function isZeroWidth(codePoint) {
  if (codePoint >= 0x20 && codePoint < 0x7f) return false;
  if (codePoint >= 0xa0 && codePoint < 0x0300) return codePoint === 0x00ad;
  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  if ((codePoint >= 0x200b && codePoint <= 0x200d)
    || codePoint === 0xfeff
    || (codePoint >= 0x2060 && codePoint <= 0x2064)) return true;
  if ((codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)) return true;
  if ((codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
    || (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
    || (codePoint >= 0x20d0 && codePoint <= 0x20ff)
    || (codePoint >= 0xfe20 && codePoint <= 0xfe2f)) return true;
  if (codePoint >= 0x0900 && codePoint <= 0x0d4f) {
    const offset = codePoint & 0x7f;
    if (offset <= 0x03) return true;
    if (offset >= 0x3a && offset <= 0x4f) return true;
    if (offset >= 0x51 && offset <= 0x57) return true;
    if (offset >= 0x62 && offset <= 0x63) return true;
  }
  if (codePoint === 0x0e31
    || (codePoint >= 0x0e34 && codePoint <= 0x0e3a)
    || (codePoint >= 0x0e47 && codePoint <= 0x0e4e)
    || codePoint === 0x0eb1
    || (codePoint >= 0x0eb4 && codePoint <= 0x0ebc)
    || (codePoint >= 0x0ec8 && codePoint <= 0x0ecd)) return true;
  if ((codePoint >= 0x0600 && codePoint <= 0x0605)
    || codePoint === 0x06dd
    || codePoint === 0x070f
    || codePoint === 0x08e2) return true;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true;
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return true;
  return false;
}

/** Display cells of a single code point, as the host renderer measures it. */
export function cellWidth(codePoint) {
  if (!Number.isFinite(codePoint)) return 1;
  if (isZeroWidth(codePoint)) return 0;
  if (isEmojiPresentation(codePoint)) return 2;
  return inRanges(codePoint, WIDE_RANGES) ? 2 : 1;
}

/** A keycap base (digit, # or *) carrying VS16 but no U+20E3 renders narrow. */
function isIncompleteKeycap(codePoints) {
  if (codePoints.length !== 2 || codePoints[1] !== 0xfe0f) return false;
  const base = codePoints[0];
  return (base >= 0x30 && base <= 0x39) || base === 0x23 || base === 0x2a;
}

/** Whether a cluster contains any emoji-ish code point, VS16, ZWJ or keycap. */
function isEmojiCluster(codePoints) {
  if (codePoints.length === 1) {
    const cp = codePoints[0];
    return isEmojiPresentation(cp) || (cp >= 0x1f000 && cp <= 0x1faff);
  }
  // VS16 and the keycap mark only appear in emoji sequences. A lone ZWJ does
  // NOT make a cluster emoji: Devanagari virama+ZWJ conjuncts use the same
  // joiner and render as one narrow glyph.
  if (codePoints.includes(0xfe0f) || codePoints.includes(0x20e3)) return true;
  return codePoints.some(cp => (
    isEmojiPresentation(cp)
    || (cp >= 0x1f000 && cp <= 0x1faff)
    || (cp >= 0x1f1e6 && cp <= 0x1f1ff)
  ));
}

/**
 * Display cells one grapheme cluster occupies.
 *
 * Emoji sequences are two cells regardless of how many code points they carry
 * (skin tone, ZWJ family, flags); a single text-default symbol without VS16
 * stays one cell, which is what terminals paint. Everything else is the East
 * Asian Width of its first visible code point (combining marks add nothing).
 *
 * @param {string} cluster
 * @returns {number}
 */
export function clusterWidth(cluster) {
  if (typeof cluster !== 'string' || cluster.length === 0) return 0;
  const codePoints = Array.from(cluster, char => char.codePointAt(0));
  if (isIncompleteKeycap(codePoints)) return 1;
  if (isEmojiCluster(codePoints)) {
    if (codePoints.length === 1) {
      const cp = codePoints[0];
      // A lone regional indicator / text-default symbol is one cell wide.
      if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return 1;
      if (!isEmojiPresentation(cp)) return 1;
    }
    return 2;
  }
  // Non-emoji cluster: spaces/spacing marks are their own cells (Thai กำ = 2),
  // so visible code points add up. A ZWJ conjunct is ONE rendered glyph - the
  // host's rule for Devanagari virama+ZWJ - so that one takes only its first
  // visible code point.
  const joined = cluster.includes('\u200d');
  let cells = 0;
  for (const cp of codePoints) {
    if (isZeroWidth(cp)) continue;
    if (joined) return cellWidth(cp);
    cells += cellWidth(cp);
  }
  return cells;
}

/**
 * Display cells of a string, measured by grapheme cluster.
 *
 * @param {string} text
 * @returns {number}
 */
export function textWidth(text) {
  let cells = 0;
  for (const cluster of units(text)) cells += clusterWidth(cluster);
  return cells;
}

/**
 * Clip to a display-cell budget, never splitting a grapheme cluster, with an
 * ellipsis when clipped.
 *
 * @param {string} text
 * @param {number} budget
 * @returns {string}
 */
export function clipCells(text, budget) {
  let used = 0;
  let out = '';
  for (const cluster of units(text)) {
    const width = clusterWidth(cluster);
    if (used + width > budget) return out + '…';
    out += cluster;
    used += width;
  }
  return out;
}

// ── word boundaries ─────────────────────────────────────────────────────────
// The layer order is the host's: cheap hard rules first (they answer the common
// cases without paying for ICU), then Intl.Segmenter over a ±32 window. Word
// segments are what group CJK typing into undoable words.

const WINDOW = 32;
const WHITESPACE = /\s/u;
const HAN = /\p{Script=Han}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;
const LATIN = /\p{Script=Latin}/u;
const DIGIT = /\p{N}/u;
/** CJK and fullwidth punctuation always severs a word. */
const CJK_PUNCT = /[\u2014\u2018\u2019\u201c\u201d\u2026\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/u;
/** Grapheme-cluster continuations: combining marks, ZWJ, variation selectors. */
const JOINER = /[\p{M}\u200d\ufe00-\ufe0f]/u;

const CLASS_OTHER = 0;
const CLASS_LATIN = 1;
const CLASS_DIGIT = 2;
const CLASS_HAN = 3;
const CLASS_KANA = 4;
const CLASS_HANGUL = 5;

/** Code point ending at \`index\`, surrogate-pair aware. */
function codePointBefore(text, index) {
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) {
      return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
    }
  }
  return low;
}

function scriptClass(codePoint) {
  const char = String.fromCodePoint(codePoint);
  if (HAN.test(char)) return CLASS_HAN;
  if (KANA.test(char)) return CLASS_KANA;
  if (HANGUL.test(char)) return CLASS_HANGUL;
  if (DIGIT.test(char)) return CLASS_DIGIT;
  if (LATIN.test(char)) return CLASS_LATIN;
  return CLASS_OTHER;
}

function isClusterJoiner(codePoint) {
  return JOINER.test(String.fromCodePoint(codePoint));
}

/** Script class before \`offset\`, skipping trailing cluster joiners. */
function leftClassAt(text, offset) {
  let index = offset;
  while (index > 0) {
    const codePoint = codePointBefore(text, index);
    if (!isClusterJoiner(codePoint)) return scriptClass(codePoint);
    index = stepBackward(text, index);
  }
  return CLASS_OTHER;
}

/** Previous code-point index before \`index\` (never splits a surrogate pair). */
function stepBackward(text, index) {
  const codePoint = codePointBefore(text, index);
  return codePoint > 0xffff ? index - 2 : index - 1;
}

/** Cheap hard rules; edges count as breaks. Offsets are UTF-16 units. */
function hardBoundaryAt(text, offset) {
  if (offset <= 0 || offset >= text.length) return true;
  const right = text.codePointAt(offset);
  // A joining mark on the right means the seam is inside a cluster - never a
  // word boundary, whatever the base character's class.
  if (isClusterJoiner(right)) return false;
  const left = codePointBefore(text, offset);
  const leftChar = String.fromCodePoint(left);
  const rightChar = String.fromCodePoint(right);
  if (WHITESPACE.test(leftChar) || WHITESPACE.test(rightChar)) return true;
  if (CJK_PUNCT.test(leftChar) || CJK_PUNCT.test(rightChar)) return true;
  return leftClassAt(text, offset) !== scriptClass(right);
}

/** UTF-16 offset of grapheme-cluster offset \`offset\`. */
function codeUnitOffsetOf(clusters, offset) {
  const limit = Math.max(0, Math.min(offset, clusters.length));
  let consumed = 0;
  for (let index = 0; index < limit; index += 1) consumed += clusters[index].length;
  return consumed;
}

/** Grapheme-cluster offset of a UTF-16 offset (clamped to a cluster edge). */
function clusterOffsetOf(clusters, offset) {
  let consumed = 0;
  for (let index = 0; index < clusters.length; index += 1) {
    if (consumed >= offset) return index;
    consumed += clusters[index].length;
  }
  return clusters.length;
}

/**
 * Whether the seam at cluster \`offset\` (\`text[offset-1] | text[offset]\`) is a
 * word boundary. Edges are boundaries.
 *
 * @param {string} text
 * @param {number} offset - grapheme-cluster offset.
 * @returns {boolean}
 */
export function isWordBoundary(text, offset) {
  const clusters = units(text);
  if (offset <= 0 || offset >= clusters.length) return true;
  const offsetInUnits = codeUnitOffsetOf(clusters, offset);
  if (hardBoundaryAt(text, offsetInUnits)) return true;
  const segmenter = wordSegmenterFor();
  if (segmenter === undefined) return true;
  const start = Math.max(0, offsetInUnits - WINDOW);
  const end = Math.min(text.length, offsetInUnits + WINDOW);
  for (const part of segmenter.segment(text.slice(start, end))) {
    if (start + part.index === offsetInUnits) return true;
  }
  return false;
}

/**
 * The word interval \`[start, end)\` holding the character at cluster \`index\`:
 * the ICU word segment when that character is word-like, otherwise the
 * character itself. Returned in grapheme-cluster offsets so a deletion run can
 * keep consuming its word and nothing else.
 *
 * @param {string} text
 * @param {number} index - grapheme-cluster offset.
 * @returns {{start: number, end: number}}
 */
export function wordRangeAt(text, index) {
  const clusters = units(text);
  const single = { start: index, end: index + 1 };
  if (index < 0 || index >= clusters.length) return single;
  const segmenter = wordSegmenterFor();
  if (segmenter === undefined) return single;
  const offset = codeUnitOffsetOf(clusters, index);
  let radius = WINDOW;
  for (;;) {
    const windowStart = Math.max(0, offset - radius);
    const windowEnd = Math.min(text.length, offset + radius);
    for (const part of segmenter.segment(text.slice(windowStart, windowEnd))) {
      const start = windowStart + part.index;
      const end = start + part.segment.length;
      if (start > offset || offset >= end) continue;
      const clipped = (start === windowStart && windowStart > 0)
        || (end === windowEnd && windowEnd < text.length);
      if (!clipped) {
        if (part.isWordLike !== true) return single;
        return {
          start: clusterOffsetOf(clusters, start),
          end: clusterOffsetOf(clusters, end),
        };
      }
      break;
    }
    if (windowStart === 0 && windowEnd === text.length) return single;
    radius = Math.min(radius * 2, text.length);
  }
}
