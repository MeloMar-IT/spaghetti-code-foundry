// spaghetti-code-foundry.com: menu, theme, copy buttons, the "on this page" highlight and search. No dependencies.
(() => {
  const $ = (s, el = document) => el.querySelector(s);

  // menu on small screens
  const toggle = $(".menu-toggle");
  const nav = $("#site-nav");
  toggle?.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
  });

  // the side navigation starts folded on small screens
  if (matchMedia("(max-width: 860px)").matches) document.querySelector(".side-wrap")?.removeAttribute("open");

  // theme: system, then light, then dark
  const root = document.documentElement;
  $(".theme-toggle")?.addEventListener("click", () => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("scf-theme", root.dataset.theme); } catch { /* private mode */ }
  });

  // diagrams: a ```mermaid block is drawn with Mermaid, loaded only on pages that have one; the code stays if it fails
  const diagrams = [...document.querySelectorAll('pre[data-lang="mermaid"]')];
  if (diagrams.length) {
    import("https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs")
      .then(async ({ default: mermaid }) => {
        const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral" });
        let n = 0;
        for (const pre of diagrams) {
          try {
            const { svg } = await mermaid.render(`diagram-${n++}`, pre.querySelector("code").textContent);
            const fig = document.createElement("figure");
            fig.className = "diagram";
            fig.innerHTML = svg;
            pre.replaceWith(fig);
          } catch { /* keep the code */ }
        }
      })
      .catch(() => { /* offline: keep the code */ });
  }

  // copy buttons on code blocks
  for (const pre of document.querySelectorAll('pre:not([data-lang="mermaid"])')) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "copy";
    b.textContent = "Copy";
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pre.querySelector("code")?.innerText ?? pre.innerText);
        b.textContent = "Copied";
      } catch {
        b.textContent = "Select and copy";
      }
      setTimeout(() => (b.textContent = "Copy"), 1600);
    });
    pre.appendChild(b);
  }

  // highlight the current section in "On this page"
  const tocLinks = [...document.querySelectorAll(".toc a")];
  if (tocLinks.length && "IntersectionObserver" in window) {
    const byId = new Map(tocLinks.map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        tocLinks.forEach((a) => a.classList.remove("active"));
        byId.get(en.target.id)?.classList.add("active");
      }
    }, { rootMargin: "-80px 0px -70% 0px" });
    for (const id of byId.keys()) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
  }

  // search over /search-index.json, loaded on first use
  const input = $("#q");
  const box = $("#search-results");
  if (!input || !box) return;
  let index = null;
  let active = -1;
  const load = async () => {
    if (index) return index;
    try {
      index = await (await fetch("/search-index.json")).json();
    } catch {
      index = [];
    }
    return index;
  };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const score = (item, words) => {
    const t = item.t.toLowerCase();
    const d = (item.d ?? item.p ?? "").toLowerCase();
    let s = 0;
    for (const w of words) {
      if (t.includes(w)) s += t.startsWith(w) ? 6 : 4;
      else if (d.includes(w)) s += 1;
      else return 0;
    }
    return s + (item.d ? 1 : 0);
  };
  const show = (open) => {
    box.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
  };
  const run = async () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) return show(false);
    const words = q.split(/\s+/);
    const hits = (await load()).map((it) => [score(it, words), it]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, 12);
    active = -1;
    box.innerHTML = hits.length
      ? hits.map(([, it]) => `<a href="${esc(it.u)}">${esc(it.t)}<small>${esc(it.p ? `in ${it.p}` : it.d ?? "")}</small></a>`).join("")
      : `<p>No results for “${esc(input.value.trim())}”.</p>`;
    show(true);
  };
  input.addEventListener("input", run);
  input.addEventListener("focus", () => void load());
  input.addEventListener("keydown", (ev) => {
    const links = [...box.querySelectorAll("a")];
    if (ev.key === "Escape") return show(false);
    if (!links.length || !["ArrowDown", "ArrowUp", "Enter"].includes(ev.key)) return;
    ev.preventDefault();
    if (ev.key === "Enter") return (location.href = (links[Math.max(0, active)] ?? links[0]).href);
    active = (active + (ev.key === "ArrowDown" ? 1 : -1) + links.length) % links.length;
    links.forEach((a, i) => a.classList.toggle("active", i === active));
    links[active].scrollIntoView({ block: "nearest" });
  });
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest(".search")) show(false);
  });
})();
