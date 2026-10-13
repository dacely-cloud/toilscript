// Structured server logging, available to request, stream, and daemon code.
@external("env", "server_log")
declare function __serverLog(level: i32, ptr: usize, len: i32): i32;

@global
export class Log {
  private static write(level: i32, message: string): bool {
    const bytes = Uint8Array.wrap(String.UTF8.encode(message));
    return __serverLog(level, bytes.dataStart, bytes.byteLength) == 1;
  }
  static info(message: string): bool { return Log.write(0, message); }
  static warn(message: string): bool { return Log.write(1, message); }
  static error(message: string): bool { return Log.write(2, message); }
}
