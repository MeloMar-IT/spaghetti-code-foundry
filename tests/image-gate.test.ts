import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript tool
import { checkImageArgs } from "../tools/image-gate.mjs";

const GATE = resolve("tools/image-gate.mjs");
const check = checkImageArgs as (tool: string, args: string[], cwd: string, root: string) => string | undefined;

let tmp: string;
let root: string;
let outside: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "image-gate-")));
  root = join(tmp, "ws");
  outside = join(tmp, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, "photo.jpg"), "x");
  writeFileSync(join(outside, "secret.png"), "secret");
  symlinkSync(join(outside, "secret.png"), join(root, "link.png"));
  symlinkSync(outside, join(root, "outdir"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("checkImageArgs", () => {
  it("allows workspace paths and ordinary options", () => {
    expect(check("magick", ["photo.jpg", "photo.png"], root, root)).toBeUndefined();
    expect(check("magick", ["photo.jpg", "-resize", "50%", "-quality", "80", "new/out.png"], root, root)).toBeUndefined();
    expect(check("magick", ["-size", "100x100", "xc:white", "blank.png"], root, root)).toBeUndefined();
    expect(check("magick", ["xc:white", "-resize", "100x100", "png:-"], root, root)).toBeUndefined();
    expect(check("magick", ["photo.jpg[0]", "-strip", "photo.png"], root, root)).toBeUndefined();
    expect(check("cwebp", ["-q", "80", "photo.jpg", "-o", "photo.webp"], root, root)).toBeUndefined();
    expect(check("dwebp", ["photo.webp", "-o", "photo.png"], root, root)).toBeUndefined();
    expect(check("pngquant", ["--quality=65-80", "--output", "small.png", "photo.jpg"], root, root)).toBeUndefined();
    expect(check("sips", ["-Z", "100", "photo.jpg", "--out", "small.jpg"], root, root)).toBeUndefined();
    expect(check("sips", ["-s", "format", "png", "photo.jpg", "--out", "photo.png"], root, root)).toBeUndefined();
    expect(check("qlmanage", ["-t", "-s", "256", "-o", ".", "photo.jpg"], root, root)).toBeUndefined();
  });

  it("refuses paths outside the workspace", () => {
    const bad = [
      ["/etc/hosts", "out.png"],
      ["photo.jpg", "../out.png"],
      ["text:/etc/passwd", "out.png"],
      ["link.png", "out.png"],
      ["outdir/secret.png", "out.png"],
      ["outdir/new.png", "x.png"],
      ["photo.jpg", "https://example.test/y.png"],
      ["msl:a.msl", "out.png"],
      ["label:hello", "out.png"],
    ];
    for (const args of bad) expect(check("magick", args, root, root), args.join(" ")).toBeTruthy();
    expect(check("cwebp", ["photo.jpg", "-o", "/tmp/x.webp"], root, root)).toMatch(/outside|allowed/);
    expect(check("cwebp", ["photo.jpg", "-o", "outdir/x.webp"], root, root)).toMatch(/outside/);
    expect(check("pngquant", ["--output=../x.png", "photo.jpg"], root, root)).toBeTruthy();
    expect(check("magick", ["photo.jpg", "out.png"], outside, root)).toMatch(/outside the workspace/);
  });

  it("refuses wildcards, spaces, quotes and interpolation", () => {
    for (const a of ["*.png", "link?.png", "{a,b}.png", "%d.png", "a b.png", "'x'.png", "@list.txt", "a|b.png", "|cat"]) {
      expect(check("magick", [a, "out.png"], root, root), a).toBeTruthy();
    }
  });

  it("refuses options that are not listed, and options that run an expression or read a file", () => {
    for (const o of [["-draw", "text 0,0 'x'"], ["-font", "/x"], ["-fx", "u"], ["-profile", "a.icc"], ["-script", "a"], ["-annotate", "0", "x"], ["-write", "a.png"], ["-unknown", "1"]]) {
      expect(check("magick", ["photo.jpg", ...o, "out.png"], root, root), o.join(" ")).toMatch(/not allowed|needs/);
    }
    expect(check("magick", ["photo.jpg", "-resize"], root, root)).toMatch(/needs/);
    expect(check("magick", ["photo.jpg", "-resize", "a b", "out.png"], root, root)).toMatch(/not allowed/);
    expect(check("magick", ["photo.jpg", "-resize", "@x", "out.png"], root, root)).toMatch(/not allowed/);
    expect(check("magick", ["photo.jpg", "-fill", "tile:/etc/passwd", "out.png"], root, root)).toMatch(/not allowed/);
  });

  it("allows qlmanage only with -t and its few options", () => {
    expect(check("qlmanage", ["photo.jpg"], root, root)).toMatch(/only with -t/);
    expect(check("qlmanage", ["-t", "-p", "photo.jpg"], root, root)).toMatch(/not allowed/);
    expect(check("nope", [], root, root)).toMatch(/not an image tool/);
  });
});

describe("the gate program", () => {
  it("runs the real tool for an allowed call and passes its exit code on", () => {
    const real = join(tmp, "magick");
    writeFileSync(real, `#!/bin/sh\ncp "$1" "$2"\nexit 3\n`);
    chmodSync(real, 0o755);
    const log = join(tmp, "refused.log");
    const r = spawnSync(process.execPath, [GATE, root, log, "magick", real, "photo.jpg", "photo.png"], { cwd: root });
    expect(r.status).toBe(3);
    expect(existsSync(join(root, "photo.png"))).toBe(true);
    expect(existsSync(log)).toBe(false);
  });

  it("names the tool by the wrapper's name, not by the real file's name", () => {
    // a real binary with another name (a symlink target): the gate still knows it is magick
    const real = join(tmp, "some-other-binary");
    writeFileSync(real, `#!/bin/sh\ncp "$1" "$2"\n`);
    chmodSync(real, 0o755);
    const log = join(tmp, "refused.log");
    const ok = spawnSync(process.execPath, [GATE, root, log, "magick", real, "photo.jpg", "photo.png"], { cwd: root, encoding: "utf8" });
    expect(ok.status).toBe(0);
    expect(existsSync(join(root, "photo.png"))).toBe(true);
    const bad = spawnSync(process.execPath, [GATE, root, log, "magick", real, "/etc/hosts", "out.png"], { cwd: root, encoding: "utf8" });
    expect(bad.status).toBe(126);
    expect(bad.stderr).toContain("image-gate: magick");
    expect(readFileSync(log, "utf8")).toBe("magick /etc/hosts out.png\n");
  });

  it("refuses with 126, logs one line and never starts the real tool", () => {
    const real = join(tmp, "magick");
    const mark = join(tmp, "ran");
    writeFileSync(real, `#!/bin/sh\ntouch '${mark}'\n`);
    chmodSync(real, 0o755);
    const log = join(tmp, "refused.log");
    const r = spawnSync(process.execPath, [GATE, root, log, "magick", real, "/etc/hosts", "out.png"], { cwd: root, encoding: "utf8" });
    expect(r.status).toBe(126);
    expect(r.stderr).toContain("image-gate: magick");
    expect(readFileSync(log, "utf8")).toBe("magick /etc/hosts out.png\n");
    expect(existsSync(mark)).toBe(false);
  });
});
