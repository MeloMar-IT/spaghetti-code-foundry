/** Limits and name tables for the repository technology profile (see repo-profile.ts). Data only. */

export const REPO_PROFILE_FILE = "repo-profile.json";
export const REPO_PROFILE_VERSION = 1;

export const REPO_PROFILE_LIMITS = {
  files: 20000, // file entries listed by the walk
  directories: 5000, // folders entered
  depth: 12, // folder levels below the root
  dirEntries: 5000, // entries read from one folder
  fileBytes: 262144, // largest file that is read
  totalBytes: 8388608, // all content read, both passes
  pathChars: 200,
  valueChars: 120,
  findings: { language: 50, manifest: 100, dependency: 150, import: 100, schema: 20, deployment: 60, command: 20 }, // 500 in total
  artifactBytes: 524288, // serialized repo-profile.json
} as const;

export const FINDING_KINDS = ["language", "manifest", "dependency", "import", "schema", "deployment", "command"] as const;
export const SKIP_CLASSES = ["vcs", "dependency", "vendor", "generated", "secret", "binary", "large", "symlink", "other"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];
export type SkipClass = (typeof SKIP_CLASSES)[number];

const DIRS: Record<string, SkipClass> = {
  ".git": "vcs", ".hg": "vcs", ".svn": "vcs",
  node_modules: "dependency", bower_components: "dependency", ".venv": "dependency", venv: "dependency",
  __pycache__: "dependency", "site-packages": "dependency", ".tox": "dependency", ".pnpm-store": "dependency",
  Pods: "dependency", ".gradle": "dependency", ".m2": "dependency",
  vendor: "vendor", third_party: "vendor", Godeps: "vendor",
  dist: "generated", build: "generated", out: "generated", target: "generated", coverage: "generated",
  ".next": "generated", ".nuxt": "generated", ".cache": "generated", ".turbo": "generated",
  ".parcel-cache": "generated", __generated__: "generated", ".terraform": "generated", obj: "generated",
};

/** Why a folder name is not entered, or undefined. */
export function skipDir(name: string): SkipClass | undefined {
  return Object.hasOwn(DIRS, name) ? DIRS[name] : undefined;
}

// Same idea as RISKY_FILE in tools/secret-scan (a script, so it cannot be imported); keep the two in step.
const RISKY_FILE = /(?:^|\/)(?:\.env(?:\.[\w-]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|p12|pfx|key|keystore|jks)|[^/]+\.tfstate(?:\.backup)?|\.npmrc|\.pypirc|\.netrc)$/;
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "ico", "bmp", "webp", "pdf", "zip", "gz", "tgz", "tar", "bz2", "xz", "7z", "jar", "war",
  "class", "so", "dll", "dylib", "exe", "o", "a", "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "mov", "avi",
  "wasm", "pyc", "bin", "dat", "sqlite", "db",
]);
const GENERATED = /(?:\.min\.(?:js|css)|\.map|\.pb\.go|\.generated\.\w+|_generated\.\w+)$/;

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const extOf = (p: string) => {
  const b = baseName(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1).toLowerCase() : "";
};

/** Why a file is not looked at (decided by its path alone), or undefined. */
export function skipFile(relPath: string): SkipClass | undefined {
  if (RISKY_FILE.test(relPath)) return "secret";
  if (BINARY_EXT.has(extOf(relPath))) return "binary";
  if (GENERATED.test(relPath)) return "generated";
  return undefined;
}

const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", java: "java", kt: "kotlin", kts: "kotlin", rs: "rust", rb: "ruby", php: "php",
  cs: "csharp", fs: "fsharp", swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  scala: "scala", ex: "elixir", exs: "elixir", dart: "dart", sh: "shell", bash: "shell", lua: "lua", r: "r",
  hs: "haskell", clj: "clojure", sql: "sql", html: "html", css: "css", scss: "scss", vue: "vue", svelte: "svelte",
  md: "markdown", yaml: "yaml", yml: "yaml", json: "json", toml: "toml", tf: "terraform",
};

/** File type by extension. Files with an unknown or no extension are not reported (policy: only recognized types). */
export function languageOf(relPath: string): string | undefined {
  const e = extOf(relPath);
  return Object.hasOwn(LANGUAGES, e) ? LANGUAGES[e] : undefined;
}

const MANIFESTS: Record<string, [string, boolean]> = {
  "package.json": ["npm", false], "package-lock.json": ["npm", true], "npm-shrinkwrap.json": ["npm", true],
  "pnpm-lock.yaml": ["pnpm", true], "pnpm-workspace.yaml": ["pnpm", false], "yarn.lock": ["yarn", true],
  "bun.lockb": ["bun", true], "bun.lock": ["bun", true],
  "go.mod": ["go", false], "go.sum": ["go", true], "go.work": ["go", false],
  "Cargo.toml": ["cargo", false], "Cargo.lock": ["cargo", true],
  "pyproject.toml": ["python", false], "setup.py": ["python", false], "setup.cfg": ["python", false], Pipfile: ["python", false],
  "Pipfile.lock": ["python", true], "poetry.lock": ["python", true], "uv.lock": ["python", true],
  "pom.xml": ["maven", false],
  "build.gradle": ["gradle", false], "build.gradle.kts": ["gradle", false], "settings.gradle": ["gradle", false], "settings.gradle.kts": ["gradle", false],
  Gemfile: ["bundler", false], "Gemfile.lock": ["bundler", true],
  "composer.json": ["composer", false], "composer.lock": ["composer", true],
  "Package.swift": ["swiftpm", false], "mix.exs": ["mix", false], "mix.lock": ["mix", true],
  Makefile: ["make", false], GNUmakefile: ["make", false], "CMakeLists.txt": ["cmake", false],
  "pubspec.yaml": ["dart", false], "pubspec.lock": ["dart", true],
  "deno.json": ["deno", false], "deno.jsonc": ["deno", false], "deno.lock": ["deno", true],
  "build.sbt": ["sbt", false], WORKSPACE: ["bazel", false], "MODULE.bazel": ["bazel", false], "BUILD.bazel": ["bazel", false],
  "nx.json": ["nx", false], "turbo.json": ["turbo", false], "lerna.json": ["lerna", false],
};

/** Build system a file belongs to, and whether it is a lockfile. */
export function manifestOf(relPath: string): { system: string; lockfile: boolean } | undefined {
  const b = baseName(relPath);
  const known = Object.hasOwn(MANIFESTS, b) ? MANIFESTS[b] : undefined;
  if (known) return { system: known[0], lockfile: known[1] };
  if (/^requirements[\w.-]*\.txt$/.test(b)) return { system: "python", lockfile: false };
  if (/\.(?:csproj|fsproj|vbproj|sln)$/.test(b)) return { system: "dotnet", lockfile: false };
  return undefined;
}

/** Schema or data-store definition file type by name (the file is named, never read), or undefined. */
export function schemaOf(relPath: string): string | undefined {
  const b = baseName(relPath);
  if (/\.schema\.json$/.test(b)) return "json-schema";
  if (/(?:^|[._-])(?:openapi|swagger)\.(?:ya?ml|json)$/i.test(b)) return "openapi";
  if (/^(?:tnsnames|sqlnet)\.ora$/i.test(b)) return "oracle-net";
  if (/^kafka(?:[._-][\w.-]*)?\.(?:properties|ya?ml)$/i.test(b)) return "kafka-config";
  switch (extOf(relPath)) {
    case "cql": return "cql";
    case "mqsc": return "mqsc";
    case "pks": case "pkb": return "plsql";
    case "sql": return "sql";
    case "prisma": return "prisma";
    case "proto": return "protobuf";
    case "graphql": case "gql": return "graphql";
    case "avsc": return "avro";
    case "xsd": return "xsd";
    default: return undefined;
  }
}

const DEPLOY_NAMES: Record<string, string> = {
  Dockerfile: "docker", ".gitlab-ci.yml": "gitlab-ci", Jenkinsfile: "jenkins", "azure-pipelines.yml": "azure-pipelines",
  "Chart.yaml": "helm", "kustomization.yaml": "kustomize", "serverless.yml": "serverless", Procfile: "procfile",
  "fly.toml": "fly", "vercel.json": "vercel", "netlify.toml": "netlify", "skaffold.yaml": "skaffold",
};

/** Deployment file type by name, or undefined. `*.tf` files give "terraform". */
export function deploymentOf(relPath: string): string | undefined {
  const b = baseName(relPath);
  if (Object.hasOwn(DEPLOY_NAMES, b)) return DEPLOY_NAMES[b];
  if (/^Dockerfile\./.test(b) || /\.dockerfile$/.test(b)) return "docker";
  if (/^(?:docker-compose[\w.-]*|compose)\.ya?ml$/.test(b)) return "compose";
  if (/(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(relPath)) return "github-actions";
  if (/(?:^|\/)\.circleci\/config\.yml$/.test(relPath)) return "circleci";
  if (extOf(relPath) === "tf") return "terraform";
  return undefined;
}
