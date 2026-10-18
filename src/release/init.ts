import type { Platform } from "./recipe.js";

// `scf release-build init`: plain detection rules that turn the list of files of a repository into a suggested
// `.factory/release-build.yaml`. No I/O and no agent: the caller hands in the files and a reader.

export const RECIPE_FILE = ".factory/release-build.yaml";
export const RECIPE_VERSION = "{commit_date}-{sha}";

/**
 * A value taken from the repository (a binary name, a folder, an image name) may reach a `run` line only if it matches this:
 * `build.ts` runs `run` through `sh -c`.
 */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const DOCKER_REPO = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;

export interface SuggestedBuild {
  name: string;
  requires: string[];
  run: string;
  artifacts: string[];
  comments: { name: string; requires: string; run: string; artifacts: string };
  on?: Platform[];
}

export interface InitOpts {
  /** The repository name; the fallback for names that cannot be read from the build files. */
  name?: string;
}

type Read = (path: string) => string | undefined;

const safeName = (s: string | undefined, fallback: string): string => (s !== undefined && SAFE_NAME.test(s) ? s : fallback);
const fallbackName = (opts: InitOpts): string => safeName(opts.name, "app");
const uniq = (l: string[]) => [...new Set(l)];

function nodeBuild(files: string[], read: Read): SuggestedBuild {
  let pm = "npm";
  let install = "npm install";
  let why = "no lock file found, so npm install";
  if (files.includes("pnpm-lock.yaml")) [pm, install, why] = ["pnpm", "pnpm install --frozen-lockfile", "pnpm-lock.yaml found, so pnpm"];
  else if (files.includes("yarn.lock")) [pm, install, why] = ["yarn", "yarn install --frozen-lockfile", "yarn.lock found, so yarn"];
  else if (files.includes("bun.lockb") || files.includes("bun.lock")) [pm, install, why] = ["bun", "bun install", "bun lock file found, so bun"];
  else if (files.includes("package-lock.json")) [pm, install, why] = ["npm", "npm ci", "package-lock.json found, so npm ci"];
  const text = read("package.json");
  let hasBuild = false;
  if (text !== undefined) {
    try {
      const scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
      hasBuild = typeof scripts === "object" && scripts !== null && typeof (scripts as Record<string, unknown>).build === "string";
    } catch {
      hasBuild = /"build"\s*:/.test(text);
    }
  }
  const run = `${install}${hasBuild ? ` && ${pm} run build` : ""} && npm pack`;
  return {
    name: "npm-package",
    requires: uniq([pm, "npm"]),
    run,
    artifacts: ["*.tgz"],
    comments: {
      name: "guessed: from package.json",
      requires: "guessed: commands the build needs on PATH",
      run: `guessed: ${why} (as tools/detect-commands)${hasBuild ? "; scripts.build found" : "; no scripts.build found"}`,
      artifacts: "guessed: the file npm pack writes",
    },
  };
}

function pythonBuild(): SuggestedBuild {
  return {
    name: "python-package",
    requires: ["python3"],
    run: "python3 -m build",
    artifacts: ["dist/*.whl", "dist/*.tar.gz"],
    comments: {
      name: "guessed: from pyproject.toml or setup.py",
      requires: "guessed: commands the build needs on PATH",
      run: "guessed: needs the build package (pip install build) on the machine",
      artifacts: "guessed: the files python -m build writes",
    },
  };
}

function gradleBuild(files: string[]): SuggestedBuild {
  const wrapper = files.includes("gradlew");
  return {
    name: "gradle-jar",
    requires: [wrapper ? "java" : "gradle"],
    run: wrapper ? "./gradlew build -x test" : "gradle build -x test",
    artifacts: ["**/build/libs/*.jar"],
    comments: {
      name: "guessed: from build.gradle",
      requires: "guessed: commands the build needs on PATH",
      run: wrapper ? "guessed: gradlew found, so the wrapper (as tools/detect-commands)" : "guessed: no gradlew found, so gradle on PATH",
      artifacts: "guessed: where Gradle writes jar files",
    },
  };
}

function mavenBuild(): SuggestedBuild {
  return {
    name: "maven-jar",
    requires: ["mvn"],
    run: "mvn -q package -DskipTests",
    artifacts: ["**/target/*.jar"],
    comments: {
      name: "guessed: from pom.xml",
      requires: "guessed: commands the build needs on PATH",
      run: "guessed: as tools/detect-commands",
      artifacts: "guessed: where Maven writes jar files",
    },
  };
}

function goBuild(files: string[], read: Read, opts: InitOpts): SuggestedBuild {
  const fallback = fallbackName(opts);
  const mod = /^module\s+(\S+)/m.exec(read("go.mod") ?? "")?.[1]?.replace(/^"|"$/g, "");
  const parts = (mod ?? "").split("/").filter(Boolean);
  if (parts.length > 1 && /^v\d+$/.test(parts.at(-1)!)) parts.pop();
  const bin = safeName(parts.at(-1), fallback);
  let pkg = ".";
  let pkgWhy = "main.go at the top";
  if (!files.includes("main.go")) {
    const cmds = files.map((f) => /^cmd\/([^/]+)\/main\.go$/.exec(f)?.[1]).filter((x): x is string => x !== undefined);
    if (cmds.length === 1 && SAFE_NAME.test(cmds[0]!)) {
      pkg = `./cmd/${cmds[0]}`;
      pkgWhy = `the only cmd/*/main.go is ${pkg}`;
    } else pkgWhy = "no single main package found: check the package to build";
  }
  const target = (os: string, arch: string, out: string) => `CGO_ENABLED=0 GOOS=${os} GOARCH=${arch} go build -o dist/${bin}-${out} ${pkg}`;
  const run = ["mkdir -p dist", target("linux", "amd64", "linux-x64"), target("darwin", "arm64", "macos-arm64"), target("windows", "amd64", "windows-x64.exe")].join(" && ");
  return {
    name: "go-binaries",
    requires: ["go"],
    run,
    artifacts: ["dist/*"],
    comments: {
      name: "guessed: from go.mod",
      requires: "guessed: commands the build needs on PATH",
      run: `guessed: one pure-Go cross-compile for three systems; ${pkgWhy}; check the binary name ${bin}`,
      artifacts: "guessed: the files go build writes into dist/",
    },
  };
}

function rustBuild(read: Read, opts: InitOpts): SuggestedBuild {
  const toml = read("Cargo.toml") ?? "";
  const section = /^\[package\][^\S\n]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml)?.[1] ?? "";
  const declared = /^\s*name\s*=\s*"([^"\n]*)"/m.exec(section)?.[1];
  const bin = safeName(declared, fallbackName(opts));
  return {
    name: "rust-binary",
    requires: ["cargo"],
    run: "cargo build --release",
    artifacts: [`target/release/${bin}`, `target/release/${bin}.exe`],
    comments: {
      name: "guessed: from Cargo.toml",
      requires: "guessed: commands the build needs on PATH",
      run: "guessed: a release build for this machine only",
      artifacts: `guessed: check the binary name ${bin}`,
    },
  };
}

function dockerBuild(opts: InitOpts): SuggestedBuild {
  // an image name must also be a valid Docker repository name: lower case, separators only between alphanumerics
  const lower = opts.name?.toLowerCase();
  const img = lower !== undefined && SAFE_NAME.test(lower) && DOCKER_REPO.test(lower) ? lower : "app";
  const tag = `${img}:"$FACTORY_RELEASE_VERSION"`;
  return {
    name: "docker-image",
    requires: ["docker", "gzip"],
    // no pipe: a failed `docker save` must fail the build
    run: `docker build -t ${tag} . && docker save -o image.tar ${tag} && gzip -f image.tar`,
    artifacts: ["image.tar.gz"],
    comments: {
      name: "guessed: from Dockerfile",
      requires: "guessed: the build needs Docker on the machine",
      run: `guessed: builds the image ${img} and saves it as a tarball`,
      artifacts: "guessed: the image tarball",
    },
  };
}

/** The builds the files suggest, in a fixed order. Only files at the top of the repository count (except the main.go files in cmd folders). */
export function detectBuilds(files: string[], read: Read, opts: InitOpts = {}): SuggestedBuild[] {
  const has = (f: string) => files.includes(f);
  const builds: SuggestedBuild[] = [];
  if (has("package.json")) builds.push(nodeBuild(files, read));
  if (has("pyproject.toml") || has("setup.py")) builds.push(pythonBuild());
  if (has("build.gradle") || has("build.gradle.kts")) builds.push(gradleBuild(files));
  if (has("pom.xml")) builds.push(mavenBuild());
  if (has("go.mod")) builds.push(goBuild(files, read, opts));
  if (has("Cargo.toml")) builds.push(rustBuild(read, opts));
  if (has("Dockerfile")) builds.push(dockerBuild(opts));
  return builds;
}

const SUPPORTED = "package.json, pyproject.toml, setup.py, build.gradle, build.gradle.kts, pom.xml, go.mod, Cargo.toml, Dockerfile";
const q = (s: string) => JSON.stringify(s);
const list = (l: string[]) => `[${l.map(q).join(", ")}]`;

function template(): string {
  return [
    `# Nothing was detected (looked for ${SUPPORTED}). Fill in this template.`,
    `# version: ${q(RECIPE_VERSION)}  # the build date and the short commit id (UTC)`,
    "# builds:",
    `#   - name: "my-build"  # a-z, 0-9 and - only`,
    `#     requires: ["make"]  # commands the build needs on PATH`,
    `#     run: "make release"  # runs with sh -c in a clean checkout; FACTORY_RELEASE_* variables are set`,
    `#     artifacts: ["dist/*"]  # globs of the files to publish, relative to the checkout`,
    "",
  ].join("\n");
}

/** The text of a suggested recipe. Every guessed line ends with a `#` comment. */
export function suggestRecipe(files: string[], read: Read, opts: InitOpts = {}): string {
  const builds = detectBuilds(files, read, opts);
  if (builds.length === 0) return template();
  const lines = [
    '# Suggested by `scf release-build init`. Every line marked "guessed" is a guess: check it before you commit this file.',
    `# Detected: ${builds.map((b) => b.comments.name.replace(/^guessed: from /, "")).join(", ")}`,
    `version: ${q(RECIPE_VERSION)}  # guessed: build date and short commit id (UTC)`,
    "builds:",
  ];
  for (const b of builds) {
    lines.push(`  - name: ${q(b.name)}  # ${b.comments.name}`);
    if (b.on) lines.push(`    on: ${list(b.on)}  # guessed: the systems this build runs on`);
    lines.push(`    requires: ${list(b.requires)}  # ${b.comments.requires}`);
    lines.push(`    run: ${q(b.run)}  # ${b.comments.run}`);
    lines.push(`    artifacts: ${list(b.artifacts)}  # ${b.comments.artifacts}`);
  }
  return lines.join("\n") + "\n";
}
