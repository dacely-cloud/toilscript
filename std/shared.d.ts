/** Numeric names for pure modules compiled by both TypeScript and ToilScript.
 * This entry provides types only. Integer casts and assignments do not wrap in
 * JavaScript: use explicit bitwise masks in shared code. */
export {};
declare global {
  type bool = boolean;
  type i8 = number;
  type u8 = number;
  type i16 = number;
  type u16 = number;
  type i32 = number;
  type u32 = number;
  type f64 = number;
}
