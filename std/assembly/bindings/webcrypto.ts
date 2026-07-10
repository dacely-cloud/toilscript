// Host-import declarations for the Web Crypto surface. The production edge
// (toil-backend `src/wasm/host/import_functions/crypto`) and the toiljs dev
// server both provide these under the `env` namespace. All byte regions are
// passed as a (pointer, length) pair into guest linear memory.
//
// Variable-length results use a two-step pull: the op returns the result
// length (>= 0) or a negative error code; the guest then allocates a buffer of
// that length and calls `take_result` to copy the bytes out.
//
// This is the guest half of the ABI contract in `crypto/algorithms.ts`; the
// byte layout of the packed params buffer is defined there.

export namespace webcrypto {
  // CSPRNG: fill outPtr..outPtr+len with random bytes.
  // @ts-ignore: decorator
  @external("env", "crypto.fill_random")
  export declare function fillRandom(outPtr: usize, len: i32): void;

  // Write 16 random bytes to outPtr (guest applies RFC 4122 v4 bits + format).
  // @ts-ignore: decorator
  @external("env", "crypto.random_uuid")
  export declare function randomUuid(outPtr: usize): void;

  // Copy the last stashed variable-length result into outPtr (outLen must equal
  // the length the producing op returned). Returns bytes written.
  // @ts-ignore: decorator
  @external("env", "crypto.take_result")
  export declare function takeResult(outPtr: usize, outLen: i32): i32;

  // digest(alg, data) -> digest length (stashed) or negative error.
  // @ts-ignore: decorator
  @external("env", "crypto.digest")
  export declare function digest(alg: i32, dataPtr: usize, dataLen: i32): i32;

  // importKey -> opaque key handle (>= 0) or negative error.
  // @ts-ignore: decorator
  @external("env", "crypto.import_key")
  export declare function importKey(
    format: i32,
    keyPtr: usize,
    keyLen: i32,
    paramsPtr: usize,
    paramsLen: i32,
    extractable: i32,
    usages: i32
  ): i32;

  // exportKey -> exported length (stashed) or negative error.
  // @ts-ignore: decorator
  @external("env", "crypto.export_key")
  export declare function exportKey(format: i32, handle: i32): i32;

  // encrypt / decrypt -> output length (stashed) or negative error.
  // @ts-ignore: decorator
  @external("env", "crypto.encrypt")
  export declare function encrypt(
    handle: i32,
    paramsPtr: usize,
    paramsLen: i32,
    dataPtr: usize,
    dataLen: i32
  ): i32;
  // @ts-ignore: decorator
  @external("env", "crypto.decrypt")
  export declare function decrypt(
    handle: i32,
    paramsPtr: usize,
    paramsLen: i32,
    dataPtr: usize,
    dataLen: i32
  ): i32;

  // sign -> signature length (stashed) or negative error.
  // @ts-ignore: decorator
  @external("env", "crypto.sign")
  export declare function sign(
    handle: i32,
    paramsPtr: usize,
    paramsLen: i32,
    dataPtr: usize,
    dataLen: i32
  ): i32;

  // verify -> 1 (valid), 0 (invalid), or negative error.
  // @ts-ignore: decorator
  @external("env", "crypto.verify")
  export declare function verify(
    handle: i32,
    paramsPtr: usize,
    paramsLen: i32,
    sigPtr: usize,
    sigLen: i32,
    dataPtr: usize,
    dataLen: i32
  ): i32;

  // deriveBits -> derived length (stashed) or negative error.
  // @ts-ignore: decorator
  @external("env", "crypto.derive_bits")
  export declare function deriveBits(
    handle: i32,
    paramsPtr: usize,
    paramsLen: i32,
    lengthBits: i32
  ): i32;

  // --- Post-quantum -------------------------------------------------------
  //
  // These are NOT WebCrypto: they are the three post-quantum primitives the edge
  // exposes, under the same `crypto.*` namespace. All are VERIFY / DECAPSULATE
  // only. The host never generates or holds a long-lived secret on the guest's
  // behalf, and there is no key handle: every input is passed by (ptr, len).

  // mldsaVerify -> 1 valid, 0 invalid, negative error. `ctx` is the ML-DSA
  // context string (may be empty).
  // @ts-ignore: decorator
  @external("env", "crypto.mldsa_verify")
  export declare function mldsaVerify(
    pkPtr: usize,
    pkLen: i32,
    msgPtr: usize,
    msgLen: i32,
    sigPtr: usize,
    sigLen: i32,
    ctxPtr: usize,
    ctxLen: i32
  ): i32;

  // mlkemDecapsulate -> 0 on success (the shared secret is written to `outPtr`)
  // or a negative error. The caller owns `sk`; the host holds no KEM key.
  // @ts-ignore: decorator
  @external("env", "crypto.mlkem_decapsulate")
  export declare function mlkemDecapsulate(
    ctPtr: usize,
    ctLen: i32,
    skPtr: usize,
    skLen: i32,
    outPtr: usize
  ): i32;

  // voprfEvaluate -> 0 on success (the evaluated element is written to `outPtr`)
  // or a negative error. `seed` is the guest's own OPRF seed.
  // @ts-ignore: decorator
  @external("env", "crypto.voprf_evaluate")
  export declare function voprfEvaluate(
    seedPtr: usize,
    seedLen: i32,
    infoPtr: usize,
    infoLen: i32,
    blindedPtr: usize,
    blindedLen: i32,
    outPtr: usize
  ): i32;
}
