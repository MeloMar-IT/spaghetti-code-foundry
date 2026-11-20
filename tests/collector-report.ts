import { randomBytes } from "node:crypto";
import { DURATION_EDGES_MS, emptyHistogram, type ShareReport } from "../src/metrics-share/report.js";

// A minimal valid shared report for the collector tests (#890); `o` replaces top-level parts.

export const randomInstall = (): string => randomBytes(16).toString("hex");

export function report(o: Partial<ShareReport> = {}): ShareReport {
  return {
    version: 1,
    install: "a".repeat(32),
    day: "2026-11-20",
    foundryVersion: "0.4.0",
    accountsSharing: 1,
    changes: { runsStarted: 1, runsEnded: { succeeded: 1, failed: 0, cancelled: 0 } },
    speed: {
      runDuration: emptyHistogram(DURATION_EDGES_MS),
      queueTime: emptyHistogram(DURATION_EDGES_MS),
      issueToPullRequest: emptyHistogram(DURATION_EDGES_MS),
      approvalLatency: emptyHistogram(DURATION_EDGES_MS),
      stepTime: {},
    },
    splits: {},
    rework: { repeatedSteps: {} },
    quality: {},
    cost: { byModel: {}, byStep: {} },
    use: { bySource: {}, byFlow: {}, repositories: 0 },
    ...o,
  };
}
