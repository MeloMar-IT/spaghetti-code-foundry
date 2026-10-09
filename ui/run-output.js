// The three output renderers of the run pages: the live log, the diff and the transcript. Each one is bounded, so a very
// long log, a very large diff or a long transcript keeps the page responsive.
import { h } from "./dom.js";
import { icon } from "./icons.js";

export const LOG_MAX = 2000;
export const DIFF_FILE_LINES = 1500;
export const TRANSCRIPT_PAGE = 200;
export const RESULT_CHARS = 20000;

// ── log ──

export function logLine(line) {
  const cls = line.startsWith("▶") ? "step" : line.startsWith("✔") ? "ok" : line.startsWith("✘") ? "fail" : line.startsWith("    ·") || line.startsWith("  ") ? "dim" : line.startsWith("⏸") || line.startsWith("↻") ? "step" : null;
  return h("span", { class: cls }, line + "\n");
}

/**
 * The live log: `el` is the pre.log. It keeps at most `max` lines, writes the lines of a burst in one batch per animation
 * frame, and follows the end only while the reader is at the end.
 */
export function createLog({ max = LOG_MAX } = {}) {
  const cap = Math.max(1, max | 0);
  const el = h("pre", { class: "log", role: "log", "aria-live": "polite", "aria-label": "Run log", tabindex: "0", "data-focus": "log" });
  const note = h("span", { class: "log-note" });
  let lines = [];
  let pending = [];
  let dropped = 0;
  let total = 0;
  let follow = true;
  let scheduled = false;

  el.addEventListener("scroll", () => {
    follow = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  });

  function flush() {
    scheduled = false;
    if (!pending.length) return;
    const nodes = pending.map(logLine);
    pending = [];
    // Read the position before any change: the browser may move scrollTop by itself while nodes come and go.
    const top = el.scrollTop;
    el.append(...nodes);
    lines.push(...nodes);
    const over = lines.length - cap;
    const grown = el.scrollHeight;
    if (over > 0) {
      for (const n of lines.splice(0, over)) n.remove();
      dropped += over;
    }
    if (dropped > 0) {
      note.textContent = dropped === 1 ? "1 earlier line is not shown" : `${dropped} earlier lines are not shown`;
      if (note.parentNode !== el) el.insertBefore(note, lines[0] ?? null);
    }
    if (follow) el.scrollTop = el.scrollHeight;
    else if (over > 0) el.scrollTop = Math.max(0, top - (grown - el.scrollHeight));
  }

  function add(line) {
    total++;
    pending.push(String(line ?? ""));
    // Frames do not run in a background tab: keep the waiting lines bounded.
    if (pending.length > cap) {
      pending.shift();
      dropped++;
    }
    if (typeof requestAnimationFrame === "function") {
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(flush);
      }
    } else flush();
  }

  return { el, add, count: () => total };
}

// ── diff ──

/** The file name of a chunk of a patch, read from its header lines (before the first hunk). Display only. */
function fileName(lines) {
  const head = [];
  for (const l of lines) {
    if (l.startsWith("@@")) break;
    head.push(l);
  }
  const from = head.find((l) => l.startsWith("rename from "));
  const to = head.find((l) => l.startsWith("rename to "));
  if (from && to) return `${from.slice(12)} → ${to.slice(10)}`;
  const plus = head.find((l) => l.startsWith("+++ "));
  if (plus && plus !== "+++ /dev/null") return plus.slice(4).replace(/^b\//, "");
  const minus = head.find((l) => l.startsWith("--- "));
  if (plus && minus) return minus.slice(4).replace(/^a\//, "");
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(head[0] ?? "");
  if (m) return m[2];
  return (head[0] ?? "").replace(/^diff /, "");
}

/** Splits a patch into one `{ file, lines }` per `diff ` line. Lines before the first one form a chunk with no file name. */
export function splitPatch(patch) {
  if (!patch) return [];
  const all = String(patch).split("\n");
  if (all[all.length - 1] === "") all.pop();
  const chunks = [];
  for (const l of all) {
    if (l.startsWith("diff ") || !chunks.length) chunks.push([]);
    chunks[chunks.length - 1].push(l);
  }
  return chunks.map((lines) => ({ file: lines[0].startsWith("diff ") ? fileName(lines) : "", lines }));
}

const diffLineClass = (l) => (l.startsWith("+++") || l.startsWith("---") ? "file" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : l.startsWith("diff ") ? "file" : null);
const diffSpan = (l) => h("span", { class: diffLineClass(l) }, l + "\n");

/** Appends many nodes in groups, so one call never gets a huge argument list. */
function appendChunked(parent, nodes, size = 2000) {
  for (let i = 0; i < nodes.length; i += size) parent.append(...nodes.slice(i, i + size));
}

function fileBody(lines) {
  const pre = h("pre", { class: "diff" }, lines.slice(0, DIFF_FILE_LINES).map(diffSpan));
  if (lines.length <= DIFF_FILE_LINES) return pre;
  const row = h("div", { class: "more-row" }, h("button", {
    type: "button",
    class: "small",
    onClick: () => {
      appendChunked(pre, lines.slice(DIFF_FILE_LINES).map(diffSpan));
      row.remove();
    },
  }, `Show all ${lines.length} lines`));
  return h("div", {}, pre, row);
}

export function diffView(d, { none = "No changes (or the workspace is not a git checkout)." } = {}) {
  if (!d.patch) return h("p", { class: "muted" }, none);
  const files = splitPatch(d.patch);
  return h("div", {},
    h("pre", { class: "mono diffstat" }, d.stat),
    d.truncated ? h("p", { class: "status bad" }, "Diff truncated (very large).") : null,
    h("div", { class: "diff-files" }, files.map(({ file, lines }) => {
      const body = h("div");
      let built = false;
      const build = () => {
        if (built) return;
        built = true;
        body.append(fileBody(lines));
      };
      const single = files.length === 1;
      if (single) build();
      return h("details", { class: "diff-file", open: single || null, onToggle: (e) => { if (e.target.open) build(); } },
        h("summary", {}, h("span", { class: "mono" }, file || "Changes"), h("span", { class: "muted" }, `${lines.length} lines`)),
        body);
    })));
}

// ── transcript ──

function toolSummary(name, input) {
  const v = input.command ?? input.file_path ?? input.pattern ?? input.path ?? input.url ?? input.description ?? "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** A pre of text; text over RESULT_CHARS is cut, with a "Show all" button for the text the page has. */
function longText(text, cls, empty) {
  const full = String(text || empty);
  if (full.length <= RESULT_CHARS) return h("pre", { class: cls }, full);
  const pre = h("pre", { class: cls }, full.slice(0, RESULT_CHARS));
  const row = h("div", { class: "more-row" }, h("button", {
    type: "button",
    class: "small",
    onClick: () => {
      pre.textContent = full;
      row.remove();
    },
  }, "Show all"));
  return h("div", {}, pre, row);
}

function eventNode(e) {
  if (e.kind === "raw") return longText(e.text, "mono", "(no output)");
  if (e.kind === "text") return h("div", { class: "tx-text" }, e.text);
  if (e.kind === "result") return h("div", { class: `tx-result${e.isError ? " bad" : ""}` },
    h("b", {}, e.isError ? "✘ Result" : "✔ Result"),
    e.costUsd ? h("span", { class: "muted mono" }, ` · $${e.costUsd.toFixed(4)} · ${e.turns} turns`) : e.tokens ? h("span", { class: "muted mono" }, ` · ${Math.round(e.tokens / 1000)}k tokens`) : null,
    h("div", {}, e.text));
  const edit = e.name === "Edit" && e.input.old_string != null;
  return h("details", { class: `tx-tool${e.isError ? " bad" : ""}` },
    h("summary", {}, h("span", { class: "pill" }, e.name), e.isError ? icon("circle-x", { label: "Failed" }) : null, h("span", { class: "mono tx-arg" }, toolSummary(e.name, e.input))),
    edit
      // One span per side, not per line: a large edit stays cheap to draw.
      ? h("pre", { class: "diff" },
        h("span", { class: "del" }, String(e.input.old_string).split("\n").map((l) => `- ${l}\n`).join("")),
        h("span", { class: "add" }, String(e.input.new_string ?? "").split("\n").map((l) => `+ ${l}\n`).join("")))
      : e.name === "Write" ? h("pre", { class: "mono" }, String(e.input.content ?? "").slice(0, 6000)) : null,
    e.result != null ? longText(e.result, "mono tx-out", "(empty)") : null);
}

export function transcriptView(events, { page = TRANSCRIPT_PAGE } = {}) {
  if (!events.length) return h("p", { class: "muted" }, "No transcript recorded.");
  const size = Math.max(1, page | 0);
  const box = h("div", { class: "transcript" });
  let shown = 0;
  let row = null;
  const more = () => {
    row?.remove();
    row = null;
    const next = events.slice(shown, shown + size);
    shown += next.length;
    box.append(...next.map(eventNode));
    const left = events.length - shown;
    if (left > 0) {
      row = h("div", { class: "more-row" }, h("button", { type: "button", class: "small", onClick: more }, `Show ${Math.min(size, left)} more`));
      box.append(row);
    }
  };
  more();
  return box;
}
