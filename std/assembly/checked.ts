/// A non-trapping integer operation. On overflow, value is zero and ok is false.
@global
export class CheckedResult<T> {
  constructor(public ok: bool, public value: T) {}
}

/// Checked arithmetic for the primitive signed/unsigned integer types.
/// Float and big-integer specializations are compile errors.
@global
export class Checked {
  static add<T>(a: T, b: T): CheckedResult<T> {
    if (!isInteger<T>() || isBoolean<T>()) ERROR('Checked arithmetic requires a primitive integer type');
    const value = <T>(a + b);
    const ok = isSigned<T>() ? (b > <T>0 ? value >= a : value <= a) : value >= a;
    return new CheckedResult<T>(ok, ok ? value : <T>0);
  }
  static subtract<T>(a: T, b: T): CheckedResult<T> {
    if (!isInteger<T>() || isBoolean<T>()) ERROR('Checked arithmetic requires a primitive integer type');
    const value = <T>(a - b);
    const ok = isSigned<T>() ? (b < <T>0 ? value >= a : value <= a) : a >= b;
    return new CheckedResult<T>(ok, ok ? value : <T>0);
  }
  static multiply<T>(a: T, b: T): CheckedResult<T> {
    if (!isInteger<T>() || isBoolean<T>()) ERROR('Checked arithmetic requires a primitive integer type');
    if (b == <T>0) return new CheckedResult<T>(true, <T>0);
    if (isSigned<T>()) {
      const minimum = <T>(<u64>1 << ((sizeof<T>() << 3) - 1));
      // Avoid Wasm's signed MIN / -1 trap as well as reporting the overflow.
      if (a == minimum && b == <T>-1) return new CheckedResult<T>(false, <T>0);
    }
    const value = <T>(a * b);
    const ok = value / b == a;
    return new CheckedResult<T>(ok, ok ? value : <T>0);
  }
}
