export class RegExp {

  // @binding(CALL_NEW, [ STRING, STRING], OBJECT_HANDLE)
  constructor(pattern: string, flags: string = "") { ERROR("RegExp is not implemented; use string operations or a supported parser"); unreachable(); }

  // @binding(CALL_THIS, [ STRING ], PASS_THRU)
  test(search: string): bool { ERROR("RegExp is not implemented; use string operations or a supported parser"); unreachable(); }

  // @binding(CALL_THIS, [], STRING)
  toString(): string { ERROR("RegExp is not implemented; use string operations or a supported parser"); unreachable(); }

}
