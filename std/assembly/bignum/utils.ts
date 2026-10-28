import { CharCode } from "util/string";
import { u128 } from "./integer/u128";
import { u256 } from "./integer/u256";

// @ts-ignore: decorator
@lazy const MaxBaseForExponent128 = memory.data<u64>([
  u64.MAX_VALUE,       // 0
  u64.MAX_VALUE,       // 1
  u64.MAX_VALUE,       // 2
  0x000006597FA94F5B,  // 3
  0x00000000FFFFFFFF,  // 4
  0x0000000003080C00,  // 5
  0x0000000000285145,  // 6
  0x000000000004E045,  // 7
  0x000000000000FFFF,  // 8
  0x0000000000004AA8,  // 9
  0x0000000000001BDB,  // 10
  0x0000000000000C6F,  // 11
  0x0000000000000659,  // 12
  0x0000000000000398,  // 13
  0x0000000000000235,  // 14
  0x0000000000000172,  // 15
  0x00000000000000FF,  // 16
  0x00000000000000B8,  // 17
  0x000000000000008A,  // 18
  0x000000000000006A,  // 19
  0x0000000000000054,  // 20
  0x0000000000000044,  // 21
  0x0000000000000038,  // 22
  0x000000000000002F,  // 23
  0x0000000000000028,  // 24
  0x0000000000000022,  // 25
  0x000000000000001E,  // 26
  0x000000000000001A,  // 27
  0x0000000000000017,  // 28
  0x0000000000000015,  // 29
  0x0000000000000013,  // 30
  0x0000000000000011,  // 31
  0x000000000000000F,  // 32
  0x000000000000000E,  // 33
  0x000000000000000D,  // 34
  0x000000000000000C,  // 35
  0x000000000000000B,  // 36
  0x000000000000000B,  // 37
  0x000000000000000A,  // 38
]);

// Use LUT wrapped by function for lazy compilation
// @ts-ignore: decorator
@lazy const RadixCharsTable = memory.data<u8>([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 36, 36, 36, 36, 36, 36,
  36, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
  25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 36, 36, 36, 36,
  36, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
  25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35
]);

// @ts-ignore: decorator
@inline export function isPowerOverflow128(base: u128, exponent: i32): bool {
  // never overflow
  if (exponent <= 1 || base <= u128.One) {
    return false;
  }
  // always overflow
  if (base.hi != 0 || exponent >= 128) {
    return true;
  }
  var low = base.lo;
  if (low <= 10) {
    switch (<i32>low) {
      case 2:
        return exponent > 127;
      case 3:
        return exponent > 80;
      case 4:
        return exponent > 63;
      case 5:
        return exponent > 55;
      case 6:
        return exponent > 49;
      case 7:
        return exponent > 45;
      case 8:
        return exponent > 42;
      case 9:
        return exponent > 40;
      case 10:
        return exponent > 38;
    }
  }
  if (exponent >= 38) return true;
  return low > load<u64>(MaxBaseForExponent128 + (exponent << 3));
}

// Divide a two-limb numerator by 10^19. The high limb must be below the
// divisor. Knuth's base-2^32 division uses native u64 division and at most two
// quotient corrections, with no per-bit loops or temporary big integers.
@lazy let decimalRemainder: u64 = 0;
function decimalQuotient(lo: u64, hi: u64): u64 {
  const divisor: u64 = 10000000000000000000;
  const base: u64 = 0x100000000;
  const mask: u64 = base - 1;
  const high = divisor >> 32, low = divisor & mask;
  let q1 = hi / high, r = hi - q1 * high;
  while (q1 >= base || q1 * low > (r << 32) + (lo >> 32)) {
    q1--; r += high;
    if (r >= base) break;
  }
  const middle = (hi << 32) + (lo >> 32) - q1 * divisor;
  let q0 = middle / high;
  r = middle - q0 * high;
  while (q0 >= base || q0 * low > (r << 32) + (lo & mask)) {
    q0--; r += high;
    if (r >= base) break;
  }
  decimalRemainder = (middle << 32) + (lo & mask) - q0 * divisor;
  return (q1 << 32) + q0;
}

function limbsToDecimal(limbs: StaticArray<u64>): string {
  let length = limbs.length;
  while (length > 0 && unchecked(limbs[length - 1]) == 0) length--;
  if (length == 0) return "0";
  let result = "";
  while (length > 0) {
    let remainder: u64 = 0;
    for (let i = length - 1; i >= 0; i--) {
      unchecked(limbs[i] = decimalQuotient(limbs[i], remainder));
      remainder = decimalRemainder;
    }
    while (length > 0 && unchecked(limbs[length - 1]) == 0) length--;
    let chunk = remainder.toString();
    if (length > 0) chunk = "0".repeat(19 - chunk.length) + chunk;
    result = chunk + result;
  }
  return result;
}

export function u128toDecimalString(value: u128): string {
  return limbsToDecimal([value.lo, value.hi]);
}

export function u256toDecimalString(value: u256): string {
  return limbsToDecimal([value.lo1, value.lo2, value.hi1, value.hi2]);
}

export function atou128(str: string, radix: i32 = 10): u128 {
  if (radix < 2 || radix > 36) {
    throw new Error("Invalid radix");
  }
  var len = str.length;
  if (!len) return u128.Zero;

  var first = str.charCodeAt(0);
  if (len == 1 && first == CharCode._0) {
    return u128.Zero;
  }
  var isNeg = first == CharCode.MINUS;
  // @ts-ignore
  var index = i32(isNeg | (first == CharCode.PLUS));

  if (str.charCodeAt(index) == CharCode._0) {
    let second = str.charCodeAt(++index);
    if ((second | 32) == CharCode.x) {
      radix = 16;
      ++index;
    } else if ((second | 32) == CharCode.o) {
      radix = 8;
      ++index;
    } else if ((second | 32) == CharCode.b) {
      radix = 2;
      ++index;
    } else if (second == CharCode._0) {
      // skip leading zeros
      while (index < len && str.charCodeAt(index) == CharCode._0) ++index;
    }
  }
  var result = u128.Zero;
  var table = RadixCharsTable;

  if (index >= len) return result;

  if (ASC_SHRINK_LEVEL >= 1) {
    let radix128 = u128.fromU64(radix);
    do {
      let n: u32 = str.charCodeAt(index) - CharCode._0;
      if (n > <u32>(CharCode.z - CharCode._0)) break;

      let num = load<u8>(table + n);
      if (num >= <u8>radix) break;

      // @ts-ignore
      result *= radix128;
      // @ts-ignore
      result += u128.fromU64(num);
    } while (++index < len);
  } else {
    switch (radix) {
      case 2: {
        do {
          let num: u32 = str.charCodeAt(index) - CharCode._0;
          if (num >= 2) break;
          // @ts-ignore
          result <<= 1;
          // @ts-ignore
          result |= u128.fromU64(num);
        } while (++index < len);
        break;
      }
      case 10: {
        do {
          let num: u32 = str.charCodeAt(index) - CharCode._0;
          if (num >= 10) break;
          // @ts-ignore
          result = (result << 3) + (result << 1);
          // @ts-ignore
          result += u128.fromU64(num);
        } while (++index < len);
        break;
      }
      case 16: {
        do {
          let n: u32 = str.charCodeAt(index) - CharCode._0;
          if (n > <u32>(CharCode.z - CharCode._0)) break;

          let num = load<u8>(table + n);
          if (num >= 16) break;

          // @ts-ignore
          result <<= 4;
          // @ts-ignore
          result |= u128.fromU64(num);
        } while (++index < len);
        break;
      }
      default: {
        let radix128 = u128.fromU64(radix);
        do {
          let n: u32 = str.charCodeAt(index) - CharCode._0;
          if (n > <u32>(CharCode.z - CharCode._0)) break;

          let num = load<u8>(table + n);
          if (num >= <u8>radix) break;

          // @ts-ignore
          result *= radix128;
          // @ts-ignore
          result += u128.fromU64(num);
        } while (++index < len);
        break;
      }
    }
  }
  // @ts-ignore
  return isNeg ? -result : result;
}
