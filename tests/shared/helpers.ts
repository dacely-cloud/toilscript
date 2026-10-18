/// <reference types="toilscript/shared" />

/** A byte helper with explicit bounds and identical JS/Wasm integer coercions. */
export function readU32BE(bytes: Uint8Array, offset: i32): u32 {
  if (offset < 0 || offset > bytes.length - 4) return 0;
  const a: u32 = bytes[offset], b: u32 = bytes[offset + 1];
  const c: u32 = bytes[offset + 2], d: u32 = bytes[offset + 3];
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/** Checked decimal cents; -1 means malformed or outside signed 32-bit cents. */
export function parseCents(text: string): i32 {
  if (text.length < 1 || text.length > 13) return -1;
  let cents: i32 = 0;
  let fraction: i32 = -1;
  let digits: i32 = 0;
  for (let i: i32 = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c == 46) {
      if (fraction >= 0 || digits == 0) return -1;
      fraction = 0;
      continue;
    }
    if (c < 48 || c > 57 || fraction == 2) return -1;
    const digit = c - 48;
    if (cents > 214748364 || (cents == 214748364 && digit > 7)) return -1;
    cents = (cents * 10 + digit) | 0;
    digits++;
    if (fraction >= 0) fraction++;
  }
  if (fraction == 0) return -1;
  const zeros = fraction < 0 ? 2 : 2 - fraction;
  for (let i: i32 = 0; i < zeros; i++) {
    if (cents > 214748364) return -1;
    cents = (cents * 10) | 0;
  }
  return cents;
}
