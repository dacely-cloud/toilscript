// Unicode 17.0.0 normalization (UAX #15) and General_Category properties.
import {
  CATEGORIES, CATEGORIES_COUNT, CATEGORY_NAMES, COMBINING, COMBINING_COUNT,
  WHITESPACE, WHITESPACE_COUNT, DECOMPOSITIONS, DECOMPOSITIONS_COUNT,
  DECOMPOSED_POINTS, COMPOSITIONS, COMPOSITIONS_COUNT,
} from "./util/unicode-data";

@inline
function at(table: usize, index: i32): i32 {
  return load<i32>(table + (<usize>index << 2));
}

function rangeProperty(table: usize, count: i32, cp: i32): i32 {
  let lo = 0, hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const start = at(table, mid * 3), end = at(table, mid * 3 + 1);
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return at(table, mid * 3 + 2);
  }
  return 0;
}

@inline
function combiningClass(cp: i32): i32 {
  return rangeProperty(COMBINING, COMBINING_COUNT, cp);
}

@global
export class Unicode {
  static version(): string { return "17.0.0"; }

  /** Two-letter Unicode General_Category, or Cn outside 0..10FFFF. */
  static category(codePoint: i32): string {
    return CATEGORY_NAMES[rangeProperty(CATEGORIES, CATEGORIES_COUNT, codePoint)];
  }

  static isLetter(codePoint: i32): bool {
    const category = rangeProperty(CATEGORIES, CATEGORIES_COUNT, codePoint);
    return category >= 1 && category <= 5;
  }

  static isMark(codePoint: i32): bool {
    const category = rangeProperty(CATEGORIES, CATEGORIES_COUNT, codePoint);
    return category >= 6 && category <= 8;
  }

  static isNumber(codePoint: i32): bool {
    const category = rangeProperty(CATEGORIES, CATEGORIES_COUNT, codePoint);
    return category >= 9 && category <= 11;
  }

  static isWhitespace(codePoint: i32): bool {
    return rangeProperty(WHITESPACE, WHITESPACE_COUNT, codePoint) != 0;
  }
}

function decompose(cp: i32, compatibility: bool, output: Array<i32>): void {
  const syllable = cp - 0xac00;
  if (<u32>syllable < 11172) {
    output.push(0x1100 + syllable / 588);
    output.push(0x1161 + (syllable % 588) / 28);
    if (syllable % 28 != 0) output.push(0x11a7 + syllable % 28);
    return;
  }
  let lo = 0, hi = DECOMPOSITIONS_COUNT - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const found = at(DECOMPOSITIONS, mid * 4);
    if (cp < found) hi = mid - 1;
    else if (cp > found) lo = mid + 1;
    else {
      if (!compatibility && at(DECOMPOSITIONS, mid * 4 + 3) != 0) break;
      const offset = at(DECOMPOSITIONS, mid * 4 + 1);
      const count = at(DECOMPOSITIONS, mid * 4 + 2);
      // The pinned Unicode mappings form an acyclic, bounded-depth graph.
      for (let i = 0; i < count; i++) decompose(at(DECOMPOSED_POINTS, offset + i), compatibility, output);
      return;
    }
  }
  output.push(cp);
}

/** Stable merge sort within a non-starter run. Long adversarial mark runs
 * remain O(n log n); normalization never insertion-sorts an unbounded run. */
function reorder(points: Array<i32>): void {
  let scratch: Array<i32> | null = null;
  for (let start = 0; start < points.length;) {
    if (combiningClass(points[start]) == 0) { start++; continue; }
    let end = start + 1;
    while (end < points.length && combiningClass(points[end]) != 0) end++;
    if (end - start > 1) {
      if (scratch == null) scratch = new Array<i32>(points.length);
      for (let width = 1; width < end - start; width *= 2) {
        for (let left = start; left < end; left += width * 2) {
          const mid = min(left + width, end), right = min(left + width * 2, end);
          let a = left, b = mid, out = left;
          while (a < mid || b < right) {
            if (a < mid && (b >= right || combiningClass(points[a]) <= combiningClass(points[b]))) {
              scratch[out++] = points[a++];
            } else {
              scratch[out++] = points[b++];
            }
          }
          for (let i = left; i < right; i++) points[i] = scratch[i];
        }
      }
    }
    start = end;
  }
}

function composePair(first: i32, second: i32): i32 {
  // Algorithmic Hangul L+V and LV+T composition.
  const l = first - 0x1100, v = second - 0x1161;
  if (<u32>l < 19 && <u32>v < 21) return 0xac00 + l * 588 + v * 28;
  const s = first - 0xac00, t = second - 0x11a7;
  if (<u32>s < 11172 && s % 28 == 0 && t > 0 && t < 28) return first + t;
  let lo = 0, hi = COMPOSITIONS_COUNT - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const a = at(COMPOSITIONS, mid * 3), b = at(COMPOSITIONS, mid * 3 + 1);
    if (first < a || (first == a && second < b)) hi = mid - 1;
    else if (first > a || second > b) lo = mid + 1;
    else return at(COMPOSITIONS, mid * 3 + 2);
  }
  return -1;
}

function compose(points: Array<i32>): void {
  if (points.length == 0) return;
  let starterPos = combiningClass(points[0]) == 0 ? 0 : -1;
  let starter = points[0], lastClass = combiningClass(points[0]), out = 1;
  for (let i = 1; i < points.length; i++) {
    const cp = points[i], cc = combiningClass(cp);
    const composite = starterPos >= 0 && (lastClass < cc || lastClass == 0) ? composePair(starter, cp) : -1;
    if (composite >= 0) {
      points[starterPos] = starter = composite;
    } else {
      if (cc == 0) { starterPos = out; starter = cp; }
      lastClass = cc;
      points[out++] = cp;
    }
  }
  points.length = out;
}

export function normalizeString(input: string, form: string): string {
  const compatibility = form == "NFKC" || form == "NFKD";
  const composed = form == "NFC" || form == "NFKC";
  if (!compatibility && form != "NFC" && form != "NFD") throw new RangeError("Invalid normalization form");
  const points = new Array<i32>();
  for (let i = 0; i < input.length; i++) {
    const cp = input.codePointAt(i);
    if (cp > 0xffff) i++;
    decompose(cp, compatibility, points);
  }
  reorder(points);
  if (composed) compose(points);
  const units = new Array<i32>();
  for (let i = 0; i < points.length; i++) {
    const cp = points[i];
    if (cp <= 0xffff) units.push(cp);
    else {
      const supplementary = cp - 0x10000;
      units.push(0xd800 + (supplementary >>> 10));
      units.push(0xdc00 + (supplementary & 1023));
    }
  }
  return String.fromCharCodes(units);
}
