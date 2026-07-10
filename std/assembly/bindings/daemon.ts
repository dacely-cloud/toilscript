// Host-import declarations for the daemon (L4 cold box) scheduler surface.
//
// Unlike every other host import, these do NOT live under `env`. Production
// registers them in their OWN wasm module namespace, `("daemon", "<name>")`
// (toil-backend `src/wasm/cold/imports.rs`, `NS_DAEMON`), and only for a cold
// box: the request module's deploy-time allowlist carries no daemon entries.
// A cold box that declares them as dotted names under `env` resolves against a
// dev emulator but falls through to the trap-on-use stub at the edge, so the
// namespace here is load-bearing rather than cosmetic.
//
// The host registers only the functions the module actually declares, so a
// daemon that never calls one never pays for it.
//
// Return convention:
//   >= 0            success: a count, an epoch, or a written byte length.
//   -1              `httpCall`: the response did not fit `outCap` (retry bigger).
//                   `nextFireMs`: unknown id, or a cron that never fires again.
//                   Neither is an error code.
//   -(0x10000 + c)  a typed failure carrying the u16 subsystem code `c`; see
//                   `DaemonError` in `~lib/daemon`, which decodes this band.
//
// The `httpCall` request/response envelopes are a bespoke little-endian framing
// (NOT the `@data` codec); `DaemonHttpRequest` / `DaemonHttpResponse` own it.

export namespace daemonHost {
  // daemon.is_leader() -> 1 when this node currently holds the lease, else 0.
  // @ts-ignore: decorator
  @external("daemon", "is_leader")
  export declare function isLeader(): i32;

  // daemon.current_epoch() -> the monotonic fencing token, or -1 when not leader.
  // @ts-ignore: decorator
  @external("daemon", "current_epoch")
  export declare function currentEpoch(): i64;

  // daemon.yield() -> 0 while still leader, else the bridged `LeaseLost`. Named
  // `yieldNow` because `yield` is a reserved word.
  // @ts-ignore: decorator
  @external("daemon", "yield")
  export declare function yieldNow(): i32;

  // daemon.sleep_ms(ms) -> 0 when the sleep completed, else the bridged
  // `LeaseLost` if the lease was lost while parked. The host CLAMPS `ms` to its
  // own ceiling (3s) and treats a negative `ms` as 0, so neither can park a
  // daemon thread for an unbounded interval.
  // @ts-ignore: decorator
  @external("daemon", "sleep_ms")
  export declare function sleepMs(ms: i64): i32;

  // daemon.task_count() -> the number of registered `@scheduled` tasks.
  // @ts-ignore: decorator
  @external("daemon", "task_count")
  export declare function taskCount(): i32;

  // daemon.next_fire_ms(taskId) -> the next wall-clock fire time in epoch ms, or
  // -1 for an out-of-range id / a cron that never fires again.
  // @ts-ignore: decorator
  @external("daemon", "next_fire_ms")
  export declare function nextFireMs(taskId: i32): i64;

  // daemon.http_call(reqPtr, reqLen, outPtr, outCap) -> the response envelope
  // LENGTH written to `outPtr` (>= 0, not packed with a pointer: the guest
  // supplied the buffer), -1 when it did not fit `outCap`, or a bridged
  // `DaemonError`. Soft-fenced: a non-leader gets `NotLeader` without hitting
  // the wire.
  // @ts-ignore: decorator
  @external("daemon", "http_call")
  export declare function httpCall(reqPtr: usize, reqLen: i32, outPtr: usize, outCap: i32): i64;
}
