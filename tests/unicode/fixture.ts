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
