// The logic of the fake `security` tool, used by fake-security.mjs (a process) and by the in-process fake of the tests.
// FAKE_KEYCHAIN_FILE: where the items live. FAKE_KEYCHAIN_LOG: one JSON line per call (arguments only).
// FAKE_KEYCHAIN_FAIL: "find", "add" or "delete" makes that call fail.
// FAKE_KEYCHAIN_FAIL_ONCE: the first call of that kind fails, later ones work (a marker file next to the items remembers it).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const OPS = { "find-generic-password": "find", "add-generic-password": "add", "delete-generic-password": "delete" };

const result = (status, stdout = "", stderr = "") => ({ status, stdout, stderr });

/** One call of the tool. `input` is what the tool would read from stdin. The environment is read on every call. */
export function fakeSecurity(args, input, env = process.env) {
  const file = env.FAKE_KEYCHAIN_FILE;
  if (env.FAKE_KEYCHAIN_LOG) appendFileSync(env.FAKE_KEYCHAIN_LOG, JSON.stringify(args) + "\n");
  const items = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
  const arg = (flag) => args[args.indexOf(flag) + 1];
  const name = `${arg("-s")}\u0000${arg("-a")}`;
  const op = OPS[args[0]];
  if (!op) return result(2);
  const once = env.FAKE_KEYCHAIN_FAIL_ONCE === op && !existsSync(`${file}.once`);
  if (once) writeFileSync(`${file}.once`, "");
  if (once || env.FAKE_KEYCHAIN_FAIL === op) return result(1, "", "security: fake failure\n");
  if (op === "find") {
    const v = items()[name];
    return v === undefined ? result(44) : result(0, v + "\n");
  }
  if (op === "delete") {
    const all = items();
    if (!(name in all)) return result(44);
    delete all[name];
    writeFileSync(file, JSON.stringify(all));
    return result(0);
  }
  // `-w` last: the password comes from stdin, twice
  if (args.at(-1) !== "-w") return result(3);
  const lines = input.split("\n");
  if (!lines[0] || lines[0] !== lines[1]) return result(4);
  const all = items();
  all[name] = lines[0];
  writeFileSync(file, JSON.stringify(all));
  return result(0);
}
