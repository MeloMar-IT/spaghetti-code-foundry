// A minimal stand-in for the parts of the DOM that `h` in ui/dom.js uses.

export class FakeNode {}

type Listener = (e?: unknown) => unknown;

export class FakeElement extends FakeNode {
  attrs: Record<string, string> = {};
  children: (FakeNode | string)[] = [];
  style: Record<string, string> = {};
  hidden = false;
  className = "";
  value = "";
  checked = false;
  disabled = false;
  scrollTop = 0;
  scrollLeft = 0;
  classList = {
    names: new Set<string>(),
    add: (n: string) => void this.classList.names.add(n),
    remove: (n: string) => void this.classList.names.delete(n),
    contains: (n: string) => this.classList.names.has(n),
    toggle: (n: string, force?: boolean) => {
      const on = force ?? !this.classList.names.has(n);
      if (on) this.classList.names.add(n);
      else this.classList.names.delete(n);
      return on;
    },
  };
  listeners: Record<string, Listener[]> = {};
  parent?: FakeElement;
  private text?: string;
  constructor(public tag: string) {
    super();
  }
  get localName(): string { return this.tag; }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
    // As in a browser, the class attribute is what classList reads.
    if (k === "class") this.classList.names = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  removeAttribute(k: string) {
    delete this.attrs[k];
    if (k === "class") this.classList.names = new Set();
  }
  addEventListener(type: string, fn: Listener) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type: string, fn: Listener) { this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== fn); }
  /** Calls the listeners of an event type (a submit, for example) with `event`. */
  fire(type: string, event: unknown = {}): void {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  private adopt(nodes: (FakeNode | string)[]) { for (const n of nodes) if (n instanceof FakeElement) n.parent = this; }
  append(...nodes: (FakeNode | string)[]) { this.adopt(nodes); this.children.push(...nodes); }
  replaceChildren(...nodes: (FakeNode | string)[]) {
    for (const c of this.children) if (c instanceof FakeElement && c.parent === this) c.parent = undefined;
    this.adopt(nodes);
    this.text = undefined;
    this.children = [...nodes];
  }
  get parentNode(): FakeElement | null { return this.parent ?? null; }
  /** Takes the element out of its parent, as the DOM does. */
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = undefined;
  }
  /** Puts `node` before `ref` (at the end when `ref` is null); a node that is somewhere else is moved. */
  insertBefore(node: FakeElement, ref: FakeNode | null): void {
    node.remove();
    const i = ref ? this.children.indexOf(ref) : -1;
    this.children.splice(i < 0 ? this.children.length : i, 0, node);
    node.parent = this;
  }
  /** A click as a browser sends it: the listeners of this element, then of each parent, until one calls stopPropagation. */
  click(): void {
    let stopped = false;
    const event = { target: this as FakeElement, currentTarget: this as FakeElement, stopPropagation: () => { stopped = true; } };
    for (let el: FakeElement | undefined = this; el && !stopped; el = el.parent) {
      event.currentTarget = el;
      for (const fn of el.listeners.click ?? []) fn(event);
    }
  }
  get textContent(): string {
    if (this.text !== undefined) return this.text;
    return this.children.map((c) => (typeof c === "string" ? c : c instanceof FakeElement ? c.textContent : "")).join("");
  }
  set textContent(v: string) { this.children = []; this.text = v; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  focus(): void { (globalThis as unknown as { document: { activeElement: FakeElement | null } }).document.activeElement = this; }
  contains(other: FakeElement | null): boolean {
    for (let el = other; el; el = el.parent ?? null) if (el === this) return true;
    return false;
  }
  /** All descendants in page order matching a comma list of `tag`, `[attr]` and `tag[attr]`; any other form throws. */
  querySelectorAll(selector: string): FakeElement[] {
    const parts = selector.split(",").map((p) => p.trim()).map((p) => {
      const m = /^([a-z0-9]*)(?:\[([a-z-]+)\])?$/.exec(p);
      if (!m || !p) throw new Error(`fake querySelectorAll: unsupported selector "${p}"`);
      return { tag: m[1], attr: m[2] };
    });
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const c of el.children) {
        if (!(c instanceof FakeElement)) continue;
        if (parts.some((p) => (!p.tag || p.tag === c.tag) && (!p.attr || p.attr in c.attrs))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  /** The nearest element from this one upwards that matches `tag[attr]` or `tag`. */
  closest(selector: string): FakeElement | null {
    const m = /^([a-z0-9]*)(?:\[([a-z-]+)\])?$/.exec(selector);
    if (!m || !selector) throw new Error(`fake closest: unsupported selector "${selector}"`);
    for (let el: FakeElement | undefined = this; el; el = el.parent) {
      if ((!m[1] || m[1] === el.tag) && (!m[2] || m[2] in el.attrs)) return el;
    }
    return null;
  }
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  all(tag: string): FakeElement[] {
    return this.children.flatMap((c) => (c instanceof FakeElement ? [...(c.tag === tag ? [c] : []), ...c.all(tag)] : []));
  }
}

/** Installs `document` and `Node` on globalThis; returns a function that restores them. */
export function installFakeDom(): () => void {
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, Node: g.Node };
  const make = (tag: string) => new FakeElement(tag);
  const byId = new Map<string, FakeElement>();
  const listeners: Record<string, Listener[]> = {};
  g.document = {
    body: make("body"),
    documentElement: make("html"),
    createElement: make,
    createElementNS: (_ns: string, tag: string) => make(tag),
    getElementById: (id: string) => byId.get(id) ?? byId.set(id, make("div")).get(id),
    title: "",
    activeElement: null as FakeElement | null,
    visibilityState: "visible",
    listeners,
    addEventListener: (type: string, fn: Listener) => { (listeners[type] ??= []).push(fn); },
    removeEventListener: (type: string, fn: Listener) => { listeners[type] = (listeners[type] ?? []).filter((l) => l !== fn); },
  };
  g.Node = FakeNode;
  return () => {
    g.document = saved.document;
    g.Node = saved.Node;
  };
}
