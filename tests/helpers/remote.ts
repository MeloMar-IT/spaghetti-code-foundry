import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { UserIo } from "../../src/auth/cli.js";
import { createUser, findUserByEmail } from "../../src/auth/users.js";
import { remoteCommand } from "../../src/remote/cli.js";
import type { Fetch } from "../../src/remote/client.js";
import type { Cmd } from "../../src/remote/spec.js";
import { startServer, type ServerOptions } from "../../src/server/server.js";
import { TEST_PASSWORD } from "./session.js";

/** A port the operating system says is free. */
export const freePort = (): Promise<number> =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });

/** What a command printed: `out` is standard output, `err` is standard error. */
export interface Ran { code: number | undefined; out: string; err: string; json<T = unknown>(): T }

/**
 * A terminal or a pipe as the real one behaves. On a terminal the answers are typed one by one. Without one nothing
 * can be asked (a question there is a mistake of the command): the answers are the lines of standard input, handed out
 * one per read, and undefined when there is none left.
 */
export function fakeIo(o: { answers?: string[]; tty?: boolean } = {}): { io: UserIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const answers = [...(o.answers ?? [])];
  const tty = o.tty ?? false;
  const typed = async (prompt: string) => {
    if (!tty) throw new Error(`asked "${prompt}" without a terminal`);
    return answers.shift() ?? "";
  };
  const io: UserIo = {
    isTTY: tty,
    ask: typed,
    askHidden: typed,
    readStdinLine: async () => (tty ? undefined : answers.shift()),
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
  };
  return { io, out, err };
}

export interface RemoteWorld {
  base: string;
  tmp: string;
  runsDir: string;
  /** Run `scf <words…>` as the signed-in admin (or as the account given by `as`). */
  scf(words: string[], o?: { as?: string; answers?: string[]; tty?: boolean; cmds?: Cmd[]; fetcher?: Fetch }): Promise<Ran>;
  /** Create the account when it is missing and sign the command line in as it; returns the name to pass as `as`. */
  signIn(email: string, role?: "admin" | "user"): Promise<string>;
  close(): void;
}

/**
 * A real server on a free port with its own data folder, and the command line signed in to it as an admin.
 * Sets FACTORY_HOME; `close()` puts it back.
 */
export async function remoteWorld(extra: Partial<ServerOptions> = {}): Promise<RemoteWorld> {
  const savedHome = process.env.FACTORY_HOME;
  const tmp = mkdtempSync(join(tmpdir(), "scf-remote-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const runsDir = join(tmp, "runs");
  const { close } = await startServer({ repo: tmp, runsDir, port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: () => {}, ...extra });
  const sessionOf = (email: string) => join(tmp, `cli-${email.replace(/\W/g, "_")}.json`);

  const scf: RemoteWorld["scf"] = async (words, o = {}) => {
    const f = fakeIo(o);
    const code = await remoteCommand(words, { io: f.io, sessionPath: sessionOf(o.as ?? "admin@example.com"), ...(o.cmds ? { cmds: o.cmds } : {}), ...(o.fetcher ? { fetcher: o.fetcher } : {}) });
    const out = f.out.join("\n");
    return { code, out, err: f.err.join("\n"), json: <T>() => JSON.parse(out) as T };
  };

  const signIn: RemoteWorld["signIn"] = async (email, role = "user") => {
    if (!findUserByEmail(email)) await createUser({ name: email.split("@")[0]!, email, password: TEST_PASSWORD, role });
    const r = await scf(["login", "--server", base, "--email", email], { as: email, answers: [TEST_PASSWORD] });
    if (r.code !== 0) throw new Error(`sign-in of ${email} failed: ${r.err}`);
    return email;
  };
  await signIn("admin@example.com", "admin");

  return {
    base, tmp, runsDir, scf, signIn,
    close() {
      close();
      if (savedHome === undefined) delete process.env.FACTORY_HOME;
      else process.env.FACTORY_HOME = savedHome;
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
