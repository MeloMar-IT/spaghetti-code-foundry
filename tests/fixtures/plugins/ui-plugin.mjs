import { fileURLToPath } from "node:url";

// A plugin with a UI: two pages, two menu items and a settings section. The handle is kept for the test.
export function register(api) {
  const handle = api.ui({
    dir: fileURLToPath(new URL("./ui-plugin", import.meta.url)),
    pages: [
      { id: "report", title: "Report", module: "report.js", roles: ["user", "admin"], files: ["style.css"] },
      { id: "secret", title: "Secret", module: "secret.js", roles: ["admin"] },
    ],
    menu: [
      { page: "report", label: "Report", roles: ["user", "admin"] },
      { page: "secret", label: "Secret", roles: ["admin"] },
    ],
    settings: {
      title: "Report plugin",
      fields: [
        { key: "limit", kind: "number", label: "Limit", help: "How many rows.", integer: true, min: 1, max: 10, default: 5 },
        { key: "verbose", kind: "yes-no", label: "Verbose", help: "Say more.", default: true },
        { key: "heading", kind: "text", label: "Heading", help: "The title." },
        { key: "tags", kind: "list", label: "Tags", help: "One per line.", maxItems: 3 },
        { key: "mode", kind: "choice", label: "Mode", help: "Pick one.", choices: ["a", "b"], default: "a" },
      ],
    },
  });
  (globalThis.__scfUi ??= []).push(handle);
}
