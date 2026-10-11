import { api } from "./api.js";
import { h, toast } from "./dom.js";

const MAX_ISSUE = 2147483647; // the server's limit

/** The issue number of what was typed ("12" or "#12"), or undefined. */
export function issueNumber(input) {
  const m = /^#?([1-9]\d{0,9})$/.exec(String(input ?? "").trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return n <= MAX_ISSUE ? n : undefined;
}

/** "From issue #N" with its link, and the build-label warning. Returns nodes (an empty list without a source). */
export function sourceSection(s, { send }) {
  const src = s?.source;
  if (!src) return [];
  const label = `#${src.issue}`;
  const link = String(src.url ?? "").startsWith("https://")
    ? h("a", { href: src.url, target: "_blank", rel: "noopener noreferrer" }, label)
    : h("span", {}, label);
  const nodes = [h("p", { class: "muted" }, "From issue ", link)];
  if (src.buildLabel) {
    const canRemove = s.mine && s.state !== "dropped" && s.repoAvailable !== false;
    const button = canRemove
      ? h("button", { class: "small", onClick: async (e) => {
        const ok = await send(e.currentTarget, () => api.removeBuildLabel(s.id));
        if (ok) toast("Build label removed");
      } }, "Remove the build label")
      : null;
    nodes.push(h("p", { class: "status bad" }, `This issue has the build label "${src.buildLabel}". The Foundry may start building it while you refine it.`, " ", button));
  }
  return nodes;
}

/** The log lines of this part in words, or "". */
export function importLogText(entry) {
  const who = entry.who || "Someone";
  if (entry.what === "imported") return `${who} started the session from issue ${entry.detail ?? ""}`.trim();
  if (entry.what === "source-label-removed") return `${who} removed the build label${entry.detail ? ` "${entry.detail}"` : ""} from the issue`;
  return "";
}
