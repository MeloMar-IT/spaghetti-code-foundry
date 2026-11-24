#!/usr/bin/env node
// The image gate of agent steps with `allow_commands: [images]`. A small `sh` wrapper per installed image tool (written per
// attempt by src/agents/command-allow.ts) calls: image-gate.mjs <workspace> <refusal log> <tool name> <real tool> [args…].
// The gate runs the real tool only when every argument passes a checked subset: options from a list per tool, no expression
// or file-reading options, no wildcards, and every path inside the workspace (symlinks followed). Otherwise it appends one
// line to the refusal log, prints the reason and exits 126. This is defence in depth: the sandbox stays the real limit.
import { spawn } from "node:child_process";
import { appendFileSync, lstatSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Value kinds of an option: v = a plain value (no path), p = a path inside the workspace. */
const words = (s, kinds) => Object.fromEntries(s.split(/\s+/).filter(Boolean).map((n) => [n, kinds]));

const MAGICK = {
  ...words("-strip -auto-orient -flatten -trim -negate -monochrome -antialias -coalesce -normalize -auto-level -auto-gamma -flip -flop -mosaic +repage +dither +antialias +adjoin", []),
  ...words(
    "-size -resize -scale -sample -thumbnail -quality -format -density -background -colorspace -gravity -extent -crop -rotate -depth -alpha -fill -interlace -sampling-factor -blur -sharpen -type -units -compress -filter -resample -geometry -border -bordercolor -level -posterize -colors -fuzz -layers -delete -loop -delay -page -transparent -dither -remap-none",
    ["v"],
  ),
};
const CWEBP = {
  ...words("-lossless -mt -exact -sharp_yuv -noalpha -strong -nostrong -short -quiet -af -jpeg_like -low_memory", []),
  ...words("-q -alpha_q -z -m -size -psnr -f -sns -segments -pass -preset -hint -near_lossless -alpha_method -alpha_filter -sharpness -metadata -partition_limit", ["v"]),
  ...words("-resize", ["v", "v"]),
  ...words("-crop", ["v", "v", "v", "v"]),
  ...words("-o", ["p"]),
};
const DWEBP = {
  ...words("-pam -ppm -bmp -tiff -pgm -nofancy -nofilter -nodither -mt -alpha -incremental -quiet -flip", []),
  ...words("-dither", ["v"]),
  ...words("-resize", ["v", "v"]),
  ...words("-crop", ["v", "v", "v", "v"]),
  ...words("-o", ["p"]),
};
const PNGQUANT = {
  ...words("--force -f --skip-if-larger --strip --verbose -v --quiet --nofs --nofs", []),
  ...words("--quality --speed --ext --posterize --floyd -s -Q", ["v"]),
  ...words("--output -o", ["p"]),
};
const SIPS = {
  ...words("-i", []),
  ...words("-Z -r -f --rotate --flip --resampleWidth --resampleHeight --resampleHeightWidthMax --deleteProperty", ["v"]),
  ...words("-z -c -p --resampleHeightWidth --padToHeightWidth --cropToHeightWidth", ["v", "v"]),
  ...words("-s --setProperty", ["v", "v"]),
  ...words("-g --getProperty", ["v"]),
  ...words("--out -o", ["p"]),
};
const QLMANAGE = {
  ...words("-t -i -x", []),
  ...words("-s -f -c", ["v"]),
  ...words("-o", ["p"]),
};
export const IMAGE_OPTIONS = { magick: MAGICK, cwebp: CWEBP, dwebp: DWEBP, pngquant: PNGQUANT, sips: SIPS, qlmanage: QLMANAGE };

/** Coders that make an image from a size or a colour, with no file behind them. */
const GENERATORS = new Set(["xc", "canvas", "gradient", "radial-gradient", "plasma", "null", "pattern"]);
/** Coders that read or write a file (the rest of the argument is a path). */
const FORMATS = new Set(["png", "jpg", "jpeg", "webp", "gif", "tiff", "tif", "bmp", "ico", "avif", "heic", "heif", "jp2", "pnm", "ppm", "pgm", "pbm", "tga", "dds", "psd", "miff"]);
const CODER = /^([A-Za-z][A-Za-z0-9+-]{1,15}):/;
/** A plain option value: a size, a colour, a number or a word. No path, no quote, no expression. */
const PLAIN_VALUE = /^(?:[\p{L}\p{N}_#%.,+\-^!<>=()]*|\d+(?::\d+)+)$/u;
/** A path or a coder argument: letters, digits and a few signs. No whitespace, quote, wildcard, `%`, `@` or `|`. */
const PATH_CHARS = /^[\p{L}\p{N}_.,:/+=~#-]+$/u;
const FRAME = /\[[0-9x,+-]*\]$/;

/** Is `p` (relative to `cwd`) inside `root`? Symlinks are followed on the deepest part that exists. */
function inside(p, cwd, root) {
  const abs = resolve(cwd, p);
  let cur = abs;
  const rest = [];
  for (;;) {
    try {
      lstatSync(cur);
      break;
    } catch {
      const up = resolve(cur, "..");
      if (up === cur) return false;
      rest.unshift(basename(cur));
      cur = up;
    }
  }
  let real;
  try {
    real = realpathSync(cur);
  } catch {
    return false; // a dangling symlink
  }
  const full = join(real, ...rest);
  const rel = relative(root, full);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The reason a path argument is refused, or undefined. `coders` allows `png:file` style prefixes (the tool is ImageMagick). */
function pathProblem(arg, cwd, root, coders) {
  if (arg === "-") return undefined;
  let rest = arg;
  if (coders) {
    const m = CODER.exec(arg);
    if (m) {
      const name = m[1].toLowerCase();
      rest = arg.slice(m[0].length);
      if (GENERATORS.has(name)) return PATH_CHARS.test(rest) || rest === "" ? undefined : "unsafe characters";
      if (!FORMATS.has(name)) return `the coder "${m[1]}:" is not allowed`;
      if (rest === "-") return undefined;
    }
  }
  if (coders) rest = rest.replace(FRAME, "");
  if (rest === "") return "an empty path";
  if (!PATH_CHARS.test(rest)) return "the path has a wildcard, a space, a quote or another character that is not allowed";
  if (rest.split("/").includes("..")) return "the path goes up with ..";
  return inside(rest, cwd, root) ? undefined : "the path is outside the workspace";
}

/**
 * Checks the arguments of one call of `tool`. Returns the reason it is refused, or undefined.
 * `cwd` is where the call runs, `root` the workspace.
 */
export function checkImageArgs(tool, args, cwd, root) {
  const opts = IMAGE_OPTIONS[tool];
  if (!opts) return `${tool} is not an image tool`;
  let realRoot;
  let realCwd;
  try {
    realRoot = realpathSync(root);
    realCwd = realpathSync(cwd);
  } catch {
    return "the workspace or the folder is not readable";
  }
  const rel = relative(realRoot, realCwd);
  if (rel.startsWith("..") || isAbsolute(rel)) return "the folder is outside the workspace";
  const coders = tool === "magick";
  if (tool === "qlmanage" && args[0] !== "-t") return "qlmanage is allowed only with -t";
  let onlyPositional = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== "string" || a.includes("\0") || a.includes("\n")) return "an argument is not allowed";
    if (onlyPositional || a === "-" || !/^[-+]/.test(a)) {
      const problem = pathProblem(a, realCwd, realRoot, coders);
      if (problem) return `${a.slice(0, 60)}: ${problem}`;
      continue;
    }
    if (a === "--") {
      onlyPositional = true;
      continue;
    }
    if (a.startsWith("@")) return "an @file argument is not allowed";
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    const kinds = Object.hasOwn(opts, name) ? opts[name] : undefined;
    if (!kinds) return `the option ${name.slice(0, 40)} is not allowed`;
    const values = eq > 0 ? [a.slice(eq + 1)] : args.slice(i + 1, i + 1 + kinds.length);
    if (eq > 0 ? kinds.length !== 1 : values.length !== kinds.length) return `the option ${name} needs ${kinds.length} value(s)`;
    let problem;
    values.forEach((v, k) => {
      if (problem) return;
      if (kinds[k] === "p") problem = pathProblem(v, realCwd, realRoot, false);
      else if (typeof v !== "string" || v.length > 64 || v.startsWith("@") || !PLAIN_VALUE.test(v)) problem = "the value is not allowed";
    });
    if (problem) return `${name}: ${problem}`;
    if (eq <= 0) i += kinds.length;
  }
  return undefined;
}
function main() {
  // The tool's name comes from the wrapper, not from the file's name: the real file may be a symlink to another binary.
  const [root, log, tool, real, ...args] = process.argv.slice(2);
  const why = checkImageArgs(tool, args, process.cwd(), root);
  if (why) {
    const line = `${tool} ${args.join(" ")}`.replace(/\s+/g, " ").slice(0, 80);
    try {
      appendFileSync(log, `${line}\n`);
    } catch {
      /* the refusal still stops this call */
    }
    process.stderr.write(`image-gate: ${tool}: ${why}\n`);
    process.exit(126);
  }
  const child = spawn(real, args, { stdio: "inherit" });
  child.on("error", (e) => {
    process.stderr.write(`image-gate: ${tool}: ${e.message}\n`);
    process.exit(127);
  });
  child.on("close", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

let started = false;
try {
  started = realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
} catch {
  /* imported */
}
if (started) main();
