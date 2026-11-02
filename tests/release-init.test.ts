import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitError, openPullRequest } from "../src/release/git.js";
import { detectBuilds, suggestRecipe } from "../src/release/init.js";
import { parseRecipe } from "../src/release/recipe.js";

const suggest = (files: Record<string, string>, opts?: { name?: string }) => suggestRecipe(Object.keys(files), (p) => files[p], opts);
const parsed = (files: Record<string, string>, opts?: { name?: string }) => parseRecipe(suggest(files, opts));
const runOf = (files: Record<string, string>, opts?: { name?: string }) => parsed(files, opts).builds[0]!.run;

describe("suggestRecipe", () => {
  it("Node with package-lock and a build script", () => {
    const r = parsed({ "package.json": '{"scripts":{"build":"tsc"}}', "package-lock.json": "{}" });
    expect(r.version).toBe("{commit_date}-{sha}");
    expect(r.builds[0]).toMatchObject({ name: "npm-package", run: "npm ci && npm run build && npm pack", artifacts: ["*.tgz"] });
  });

  it("Node with pnpm-lock, and with no lock file and no build script", () => {
    const p = parsed({ "package.json": '{"scripts":{"build":"x"}}', "pnpm-lock.yaml": "" }).builds[0]!;
    expect(p.run).toBe("pnpm install --frozen-lockfile && pnpm run build && npm pack");
    expect(p.requires).toEqual(["pnpm", "npm"]);
    expect(runOf({ "package.json": "{}" })).toBe("npm install && npm pack");
    expect(runOf({ "package.json": "{}", "yarn.lock": "" })).toBe("yarn install --frozen-lockfile && npm pack");
    expect(runOf({ "package.json": "{}", "bun.lock": "" })).toBe("bun install && npm pack");
  });

  it("Node: a package.json that is not JSON, or cannot be read", () => {
    expect(runOf({ "package.json": '{ "scripts": { "build": "x", }' })).toBe("npm install && npm run build && npm pack");
    const files = ["package.json"];
    expect(parseRecipe(suggestRecipe(files, () => undefined)).builds[0]!.run).toBe("npm install && npm pack");
  });

  it("Python", () => {
    const b = parsed({ "pyproject.toml": "" }).builds[0]!;
    expect(b).toMatchObject({ name: "python-package", run: "python3 -m build", artifacts: ["dist/*.whl", "dist/*.tar.gz"] });
    expect(parsed({ "setup.py": "" }).builds[0]!.name).toBe("python-package");
  });

  describe("Go", () => {
    it("builds three targets named after the module", () => {
      const b = parsed({ "go.mod": "module github.com/acme/tool\n\ngo 1.22\n", "main.go": "" }).builds[0]!;
      expect(b.requires).toEqual(["go"]);
      expect(b.run).toContain("-o dist/tool-linux-x64 .");
      expect(b.run).toContain("GOOS=darwin GOARCH=arm64 go build -o dist/tool-macos-arm64 .");
      expect(b.run).toContain("dist/tool-windows-x64.exe .");
      expect(b.artifacts).toEqual(["dist/*"]);
    });
    it("uses the only cmd/<x>", () => {
      expect(runOf({ "go.mod": "module example.com/tool/v2\n", "cmd/tool/main.go": "" })).toContain("dist/tool-linux-x64 ./cmd/tool");
    });
    it("falls back for a module name with odd characters", () => {
      const run = runOf({ "go.mod": "module example.com/$(id)\n", "main.go": "" }, { name: "repo" });
      expect(run).toContain("dist/repo-linux-x64");
      expect(run).not.toContain("$(");
    });
    it.each(["cmd/my tool/main.go", "cmd/a'b/main.go", "cmd/$(touch x)/main.go", "cmd/`id`/main.go", "cmd/a;b/main.go"])("never puts %s into the run line", (path) => {
      const run = runOf({ "go.mod": "module example.com/tool\n", [path]: "" });
      expect(run).toContain("dist/tool-linux-x64 .");
      for (const bad of ["'", "$(", "`", ";", " tool/"]) expect(run).not.toContain(bad);
    });
    it("uses . for several cmd folders", () => {
      expect(runOf({ "go.mod": "module example.com/tool\n", "cmd/a/main.go": "", "cmd/b/main.go": "" })).toContain("dist/tool-linux-x64 .");
    });
  });

  it("Rust: the package name, a workspace, and an unsafe name", () => {
    const b = parsed({ "Cargo.toml": '[package]\nname = "tool"\nversion = "0.1.0"\n[dependencies]\nname = "x"\n' }).builds[0]!;
    expect(b).toMatchObject({ name: "rust-binary", run: "cargo build --release", artifacts: ["target/release/tool", "target/release/tool.exe"] });
    expect(parsed({ "Cargo.toml": '[workspace]\nmembers = ["a"]\n' }, { name: "repo" }).builds[0]!.artifacts[0]).toBe("target/release/repo");
    expect(parsed({ "Cargo.toml": '[package]\nname = "x$(id)"\n' }).builds[0]!.artifacts[0]).toBe("target/release/app");
  });

  it("Docker: the image name comes from the repository name, lower case; an unsafe name falls back", () => {
    const b = parsed({ Dockerfile: "FROM x" }, { name: "My-App" }).builds[0]!;
    expect(b.requires).toContain("docker");
    expect(b.artifacts).toEqual(["image.tar.gz"]);
    expect(b.run).toBe('docker build -t my-app:"$FACTORY_RELEASE_VERSION" . && docker save -o image.tar my-app:"$FACTORY_RELEASE_VERSION" && gzip -f image.tar');
    expect(b.run).not.toContain("|");
    const bad = runOf({ Dockerfile: "" }, { name: "a b" });
    expect(bad).toContain("-t app:");
  });

  it.each(["my.repo-", "-x", "a--", "a..b", "x_"])("Docker: %s is not a valid image name, so it falls back", (name) => {
    expect(runOf({ Dockerfile: "" }, { name })).toContain("-t app:");
  });

  it("Docker: a failed docker save fails the run line", () => {
    const dir = mkdtempSync(join(tmpdir(), "scf-init-docker-"));
    try {
      writeFileSync(join(dir, "docker"), '#!/bin/sh\n[ "$1" = save ] && exit 3\nexit 0\n', { mode: 0o755 });
      const run = runOf({ Dockerfile: "" });
      const r = spawnSync("sh", ["-c", run], { cwd: dir, env: { PATH: `${dir}:${process.env.PATH}`, FACTORY_RELEASE_VERSION: "1" } });
      expect(r.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Gradle with and without gradlew, and Maven", () => {
    expect(parsed({ "build.gradle": "", gradlew: "" }).builds[0]).toMatchObject({ requires: ["java"], run: "./gradlew build -x test" });
    expect(parsed({ "build.gradle.kts": "" }).builds[0]).toMatchObject({ requires: ["gradle"], run: "gradle build -x test" });
    expect(parsed({ "pom.xml": "" }).builds[0]).toMatchObject({ requires: ["mvn"], run: "mvn -q package -DskipTests", artifacts: ["**/target/*.jar"] });
  });

  it("a mixed repository gives one build per kind with unique names", () => {
    const files = { "package.json": "{}", Dockerfile: "", "go.mod": "module example.com/tool\n", "main.go": "" };
    const r = parsed(files);
    expect(r.builds.map((b) => b.name)).toEqual(["npm-package", "go-binaries", "docker-image"]);
  });

  it("marks every guessed line with a comment", () => {
    const all: Record<string, string> = { "package.json": "{}", "pyproject.toml": "", "pom.xml": "", "build.gradle": "", "go.mod": "module a/b\n", "main.go": "", "Cargo.toml": "", Dockerfile: "" };
    for (const files of [all, { "package.json": "{}" }, { Dockerfile: "" }]) {
      const lines = suggest(files).split("\n").filter((l) => l.trim() && !l.startsWith("#") && l !== "builds:");
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(l).toContain("  # ");
    }
    expect(parsed(all).builds).toHaveLength(7);
  });

  it("prints a commented template when nothing is detected", () => {
    const files = { "README.md": "" };
    expect(detectBuilds(Object.keys(files), (p) => files[p])).toEqual([]);
    const text = suggest(files);
    const lines = text.split("\n").filter(Boolean);
    expect(lines[0]).toMatch(/^# Nothing was detected/);
    expect(lines.every((l) => l.startsWith("#"))).toBe(true);
    expect(text).toContain('# version: "{commit_date}-{sha}"');
  });
});

describe("openPullRequest", () => {
  const code = (branch: string) => {
    try {
      openPullRequest({ cwd: tmpdir(), env: { FACTORY_GH_BIN: join(tmpdir(), "no-such-gh-for-test") } }, "a/b", branch);
    } catch (e) {
      return e instanceof GitError ? e.code : "other";
    }
    return "none";
  };
  it("counts a branch the store refuses as a failed gh call, and does not run gh", () => {
    // A missing gh would be "no-gh": the code shows that gh never ran.
    expect(code("-x")).toBe("gh-failed");
    expect(code("x")).toBe("no-gh");
  });
});
