// The eight page templates: each returns `div.page.page-<name>` with its regions as plain divs in a fixed order.
// The head is the kit pageHeader in its toolbar layout (options title, back, status, actions), or a ready node (`head`).
// An empty slot (null, false, [] or a list of those) draws no region. Rules for the regions are in css/templates.css.
import { h } from "./dom.js";
import { pageHeader } from "./kit/product.js";

const HEAD = ["head", "title", "back", "status", "actions", "notices"];
const filled = (slot) => [slot].flat(Infinity).some((n) => n != null && n !== false);
const region = (cls, slot) => (filled(slot) ? h("div", { class: cls }, slot) : null);

function headOf({ head, title, back, status, actions }) {
  if (filled(head)) {
    if ([title, back, status, actions].some((v) => v !== undefined)) throw new Error("a page takes head or the header options, not both");
    return head;
  }
  return pageHeader({ layout: "toolbar", title, back, meta: status, actions });
}

/** The root of a template. `slots` are the option names the template accepts besides the head options. */
function page(name, opts = {}, slots, regions) {
  for (const k of Object.keys(opts)) if (!HEAD.includes(k) && !slots.includes(k)) throw new Error(`page-${name}: unknown option "${k}"`);
  return h("div", { class: `page page-${name}` }, headOf(opts), region("page-notices", opts.notices), regions(opts));
}

/** A body is drawn only when one of its regions is. */
const body = (cls, ...regions) => (regions.some(Boolean) ? h("div", { class: cls }, regions) : null);

export const overviewPage = (o) => page("overview", o, ["summary", "sections"],
  ({ summary, sections }) => [region("page-summary", summary), region("page-sections", sections)]);

export const settingsPage = (o) => page("settings", o, ["sections"], ({ sections }) => region("page-sections", sections));

export const collectionPage = (o) => page("collection", o, ["filters", "list", "empty"],
  ({ filters, list, empty }) => [region("page-filters", filters), region("page-list", list), region("page-empty", empty)]);

export const boardPage = (o) => page("board", o, ["filters", "columns"],
  ({ filters, columns }) => [region("page-filters", filters), region("page-columns", columns)]);

export const masterDetailPage = (o) => page("master-detail", o, ["master", "detail"],
  ({ master, detail }) => body("page-body", region("page-side", master), region("page-main", detail)));

export const editorPage = (o) => page("editor", o, ["main", "side"],
  ({ main, side }) => body("editor page-body", region("page-side", side), region("page-main", main)));

export const conversationPage = (o) => page("conversation", o, ["thread", "composer", "side"],
  ({ thread, composer, side }) => [region("page-thread", thread), region("page-composer", composer), region("page-side", side)]);

export const detailPage = (o) => page("detail", o, ["meta", "sections", "side"],
  ({ meta, sections, side }) => [
    region("page-meta", meta),
    body(filled(side) ? "page-body with-side" : "page-body", region("page-sections", sections), region("page-side", side)),
  ]);
