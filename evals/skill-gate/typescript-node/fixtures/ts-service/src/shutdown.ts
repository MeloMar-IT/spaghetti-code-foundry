export interface SignalSource {
  on(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  exit(code: number): void;
}

export interface Closable {
  close(callback: (err?: Error) => void): unknown;
}

export function handleSignals(proc: SignalSource, server: Closable): void {
  proc.on("SIGTERM", () => {
    server.close(() => {});
    proc.exit(0);
  });
}
