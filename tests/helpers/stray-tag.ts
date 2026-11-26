// For test files only (it needs the vitest worker): this run's tag, given by tests/global-setup.ts.
import { inject } from "vitest";
import * as procs from "./stray-procs.js";

export const strayTag = (): string => inject("strayTag") ?? "scf-stray-none";
export const stubbornShell = (pidFile: string): string => procs.stubbornShell(pidFile, strayTag());
export const stubbornArgs = (pidFile: string): string[] => procs.stubbornArgs(pidFile, strayTag());
