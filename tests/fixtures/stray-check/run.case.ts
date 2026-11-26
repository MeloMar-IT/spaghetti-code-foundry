// Run only by tests/stray-check.test.ts. STRAY_CASE: "timeout" (a test that times out with a stubborn child, which its
// cleanup kills) or "leak" (processes left behind on purpose). STRAY_DIR gets the pid files.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, it } from "vitest";
import { Watched } from "../../helpers/stray-procs.js";
import { stubbornArgs } from "../../helpers/stray-tag.js";

const dir = process.env.STRAY_DIR!;
const until = async (file: string) => {
  while (!(existsSync(file) && readFileSync(file, "utf8").endsWith("\n"))) await new Promise((r) => setTimeout(r, 25));
};
const stubborn = () => {
  const child = spawn("sh", stubbornArgs(join(dir, "stubborn.pid")), { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid!;
};

if (process.env.STRAY_CASE === "timeout") {
  const watched = new Watched();
  afterEach(() => watched.kill());
  it("times out with a stubborn child that is ready", async () => {
    watched.group(stubborn());
    await until(join(dir, "stubborn.pid"));
    await new Promise(() => {});
  }, 3000);
}

if (process.env.STRAY_CASE === "leak") {
  it("leaves a tagged loop, and a child without a mark whose parent has ended", async () => {
    stubborn();
    // the parent stays long enough to be seen with its child, then ends
    const parent = spawn("sh", ["-c", `sleep 61 >/dev/null 2>&1 & echo $! > "$STRAY_DIR/orphan.pid"; sleep 2`], { stdio: "ignore" });
    await until(join(dir, "stubborn.pid"));
    await new Promise((r) => parent.on("exit", r));
  });
}
