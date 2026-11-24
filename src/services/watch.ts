import { isDeepStrictEqual } from "node:util";
import type { ServiceConfig } from "../config.js";
import { configVersion } from "../config.js";

export interface ServiceConfigWatchOptions {
  /** The text of config.yaml; may throw. */
  read: () => string;
  /** The services in this text; throws when the text is not valid settings. */
  parse: (text: string) => readonly ServiceConfig[];
  /** The list the supervisor started with. */
  initial: readonly ServiceConfig[];
  apply: (services: readonly ServiceConfig[]) => void;
  log: (line: string) => void;
  everyMs?: number;
}

export interface ServiceConfigWatch {
  tick(): void;
  start(): void;
  stop(): void;
}

/**
 * Polls config.yaml and hands a changed `services:` list to `apply` (#941). A version counts only after two checks in a row
 * read the same text, so a half-written file is never applied. A bad, empty or unreadable file changes nothing and is logged
 * once per version, with fixed words only.
 */
export function watchServiceConfig(o: ServiceConfigWatchOptions): ServiceConfigWatch {
  let last: readonly ServiceConfig[] = o.initial;
  let seen: string | undefined;
  let done: string | undefined;
  let badLogged: string | undefined;
  let timer: NodeJS.Timeout | undefined;

  const bad = (v: string, line: string): void => {
    if (badLogged === v) return;
    badLogged = v;
    o.log(line);
  };

  const tick = (): void => {
    let text: string;
    try {
      text = o.read();
    } catch {
      seen = undefined;
      bad("unreadable", "services: config.yaml cannot be read; the services keep their last list");
      return;
    }
    if (badLogged === "unreadable") badLogged = undefined;
    const v = configVersion(text);
    const prev = seen;
    seen = v;
    if (v === done) return;
    if (v !== prev) return;
    done = v;
    if (text.trim() === "") return bad(v, "services: config.yaml is empty; the services keep their last list");
    let list: readonly ServiceConfig[];
    try {
      list = o.parse(text);
    } catch {
      return bad(v, "services: config.yaml is not valid; the services keep their last list");
    }
    if (isDeepStrictEqual(list, last)) return;
    last = list;
    try {
      o.apply(list);
    } catch {
      o.log("services: the change in config.yaml could not be applied");
    }
  };

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(tick, o.everyMs ?? 1000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
