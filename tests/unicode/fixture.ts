export function normalize(ptr:usize, length:i32, form:i32):i32 {
  const value=String.UTF16.decodeUnsafe(ptr,<usize>length);
  const forms=['NFC','NFD','NFKC','NFKD'];
  const result=value.normalize(forms[form]);
  String.UTF16.encodeUnsafe(changetype<usize>(result),result.length,32768);
  return result.length*2;
}
export function category(cp:i32):i32 {
  const value=Unicode.category(cp);
  return (value.charCodeAt(0)<<8)|value.charCodeAt(1);
}
export function properties(cp:i32):i32 {
  return <i32>Unicode.isLetter(cp)|(<i32>Unicode.isMark(cp)<<1)|(<i32>Unicode.isNumber(cp)<<2)|(<i32>Unicode.isWhitespace(cp)<<3);
}
export function invalidForm():void { ''.normalize('invalid'); }

export function lowercase(ptr: usize, length: i32): i32 {
  const value = String.UTF16.decodeUnsafe(ptr, <usize>length).toLowerCase();
  String.UTF16.encodeUnsafe(changetype<usize>(value), value.length, 32768);
  return value.length * 2;
}
export function decimal(lo1: u64, lo2: u64, hi1: u64, hi2: u64, wide: bool): i32 {
  const value = wide ? new u256(lo1, lo2, hi1, hi2).toString() : new u128(lo1, lo2).toString();
  String.UTF16.encodeUnsafe(changetype<usize>(value), value.length, 32768);
  return value.length * 2;
}

export function normalizeLiteral(ptr: usize, length: i32, form: i32): i32 {
  const input = String.UTF16.decodeUnsafe(ptr, <usize>length);
  let output = '';
  if (form == 0) output = input.normalize();
  else if (form == 1) output = input.normalize('NFD');
  else if (form == 2) output = input.normalize('NFKC');
  else output = input.normalize('NFKD');
  String.UTF16.encodeUnsafe(changetype<usize>(output), output.length, 32768);
  return output.length * 2;
}
