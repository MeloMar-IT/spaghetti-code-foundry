import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { UserIo } from "../../src/auth/cli.js";
import { createUser, findUserByEmail } from "../../src/auth/users.js";
import { remoteCommand } from "../../src/remote/cli.js";
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

export interface Ran { code: number | undefined; out: string; json<T = unknown>(): T }

export interface RemoteWorld {
  base: string;
  tmp: string;
  runsDir: string;
  /** Run `scf <words…>` as the signed-in admin (or as the account given by `as`). */
  scf(words: string[], o?: { as?: string; answers?: string[]; tty?: boolean; cmds?: Cmd[] }): Promise<Ran>;
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
    const lines: string[] = [];
    const answers = [...(o.answers ?? [])];
    const io: UserIo = {
      isTTY: o.tty ?? false,
      ask: async () => answers.shift() ?? "",
      askHidden: async () => answers.shift() ?? "",
      readStdinLine: async () => answers.shift(),
      out: (l) => void lines.push(l),
    };
    const code = await remoteCommand(words, { io, sessionPath: sessionOf(o.as ?? "admin@example.com"), ...(o.cmds ? { cmds: o.cmds } : {}) });
    const out = lines.join("\n");
    return { code, out, json: <T>() => JSON.parse(out) as T };
  };

  const signIn: RemoteWorld["signIn"] = async (email, role = "user") => {
    if (!findUserByEmail(email)) await createUser({ name: email.split("@")[0]!, email, password: TEST_PASSWORD, role });
    const r = await scf(["login", "--server", base, "--email", email], { as: email, answers: [TEST_PASSWORD] });
    if (r.code !== 0) throw new Error(`sign-in of ${email} failed: ${r.out}`);
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
