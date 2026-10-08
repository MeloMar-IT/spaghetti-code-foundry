// SCF UI redesign prototype (#248). Switches, link carrying, panels and keys. No network, no framework.
(function () {
  var DEFAULTS = { role: "admin", theme: "auto", width: "wide", state: "data", alt: "a", run: "waiting" };
  var ROLES = ["admin", "user"];
  var THEMES = ["auto", "light", "dark"];
  var WIDTHS = ["wide", "narrow"];
  var ORDER = ["role", "theme", "width", "state", "alt", "run"];

  function words(text) {
    return text ? String(text).split(/\s+/).filter(Boolean) : [];
  }

  /** The alternatives, states and runs the page declares on its <html> element. */
  function options(root) {
    var alts = words(root.getAttribute("data-alts"));
    var states = words(root.getAttribute("data-states"));
    return { alts: alts.length ? alts : ["a"], states: states.length ? states : ["data"], runs: words(root.getAttribute("data-runs")) };
  }

  function parse(search) {
    var out = {};
    String(search || "").replace(/^\?/, "").split("&").forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf("=");
      var key = decodeURIComponent(i < 0 ? pair : pair.slice(0, i));
      out[key] = decodeURIComponent(i < 0 ? "" : pair.slice(i + 1));
    });
    return out;
  }

  function pick(value, allowed, fallback) {
    return allowed.indexOf(value) >= 0 ? value : fallback;
  }

  /** Values from the query string. Anything unknown, or that the page does not have, becomes the default. */
  function read(search, opts) {
    var q = parse(search);
    var values = {
      role: pick(q.role, ROLES, DEFAULTS.role),
      theme: pick(q.theme, THEMES, DEFAULTS.theme),
      width: pick(q.width, WIDTHS, DEFAULTS.width),
      alt: pick(q.alt, opts.alts, DEFAULTS.alt),
      state: pick(q.state, opts.states, DEFAULTS.state),
    };
    if (values.alt !== "a") values.state = "data";
    if (opts.runs.length) values.run = pick(q.run, opts.runs, opts.runs[0]);
    return values;
  }

  /** The query string for these values, without the defaults. "" when nothing differs. */
  function query(values) {
    var parts = [];
    ORDER.forEach(function (k) {
      if (values[k] !== undefined && values[k] !== DEFAULTS[k]) parts.push(k + "=" + encodeURIComponent(values[k]));
    });
    return parts.length ? "?" + parts.join("&") : "";
  }

  /** For a link to another *.html page: adds the current role, theme and width. The link's own values win. Other links stay as they are. */
  function carry(href, values) {
    if (!/^[\w.-]+\.html(?:[?#]|$)/.test(href)) return href;
    var hash = "";
    var h = href.indexOf("#");
    if (h >= 0) { hash = href.slice(h); href = href.slice(0, h); }
    var q = href.indexOf("?");
    var base = q < 0 ? href : href.slice(0, q);
    var own = q < 0 ? "" : href.slice(q + 1);
    var have = parse(own);
    var add = [];
    ["role", "theme", "width"].forEach(function (k) {
      if (have[k] === undefined && values[k] !== undefined) add.push(k + "=" + encodeURIComponent(values[k]));
    });
    var all = [own].concat(add).filter(Boolean).join("&");
    return base + (all ? "?" + all : "") + hash;
  }

  /** Opens or closes a panel. Opening focuses the first [autofocus] inside; closing returns focus to the opener. */
  function toggle(panel, open, opener) {
    panel.hidden = !open;
    if (open) {
      var first = panel.querySelector("[autofocus]");
      if (first) first.focus();
    } else if (opener) {
      opener.focus();
    }
  }

  /** "search" for Cmd+K, Ctrl+K, or "/" outside a text field; "close" for Escape; else "". */
  function key(event) {
    var k = event.key;
    if ((event.metaKey || event.ctrlKey) && String(k).toLowerCase() === "k") return "search";
    if (k === "Escape") return "close";
    if (k === "/") {
      var t = event.target;
      var tag = t && t.tagName ? String(t.tagName).toUpperCase() : "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return "";
      return "search";
    }
    return "";
  }

  globalThis.Proto = { options: options, read: read, query: query, carry: carry, toggle: toggle, key: key };

  // ── wiring (browser only) ──

  function wire() {
    var root = document.documentElement;
    var opts = options(root);
    var values = read(location.search, opts);
    var openers = {};

    // Dense states: a few sample rows are repeated up to the number in data-repeat.
    document.querySelectorAll("[data-repeat]").forEach(function (el) {
      var kids = Array.prototype.slice.call(el.children);
      var n = Number(el.getAttribute("data-repeat")) || kids.length;
      for (var i = kids.length; i < n; i++) el.appendChild(kids[i % kids.length].cloneNode(true));
    });

    function apply() {
      ORDER.forEach(function (k) {
        if (values[k] !== undefined) root.setAttribute("data-" + k, values[k]);
      });
      document.querySelectorAll("a[href]").forEach(function (a) {
        if (!a.dataset.href0) a.dataset.href0 = a.getAttribute("href");
        a.setAttribute("href", carry(a.dataset.href0, values));
        var file = a.dataset.href0.split("?")[0];
        if (a.closest(".side")) {
          if (location.pathname.split("/").pop() === file) a.setAttribute("aria-current", "page");
          else a.removeAttribute("aria-current");
        }
      });
      if (history.replaceState) history.replaceState(null, "", location.pathname + query(values));
    }

    function closeAll() {
      document.querySelectorAll(".panel").forEach(function (p) {
        if (!p.hidden) toggle(p, false, openers[p.id]);
      });
    }

    function select(label, name, items) {
      var s = document.createElement("select");
      items.forEach(function (v) {
        var o = document.createElement("option");
        o.value = v;
        o.textContent = v;
        if (values[name] === v) o.selected = true;
        s.appendChild(o);
      });
      s.addEventListener("change", function () {
        values[name] = s.value;
        if (name === "alt" && values.alt !== "a") values.state = "data";
        apply();
        draw();
      });
      var l = document.createElement("label");
      l.append(label + " ", s);
      return l;
    }

    var bar = document.createElement("div");
    bar.className = "switches";
    function draw() {
      bar.replaceChildren();
      bar.append(select("Role", "role", ROLES), select("Theme", "theme", THEMES), select("Width", "width", WIDTHS), select("Alternative", "alt", opts.alts));
      if (opts.states.length > 1) bar.append(select("State", "state", values.alt === "a" ? opts.states : ["data"]));
      if (opts.runs.length) bar.append(select("Run", "run", opts.runs));
    }
    document.body.insertBefore(bar, document.body.firstChild);
    draw();
    apply();

    document.addEventListener("click", function (e) {
      var el = e.target.closest ? e.target.closest("[data-open], [data-close], [data-drawer], [data-compact]") : null;
      if (!el) return;
      if (el.hasAttribute("data-open")) {
        if (e.preventDefault) e.preventDefault();
        var panel = document.getElementById(el.getAttribute("data-open"));
        if (panel) { closeAll(); openers[panel.id] = el; toggle(panel, true, el); }
      } else if (el.hasAttribute("data-close")) {
        var p = el.closest(".panel");
        if (p) toggle(p, false, openers[p.id]);
      } else if (el.hasAttribute("data-drawer")) {
        document.querySelector(".app").classList.toggle("drawer-open");
      } else if (el.hasAttribute("data-compact")) {
        document.querySelector(".main").classList.toggle("compact", el.checked);
      }
    });

    // A link to a collapsed section opens it.
    function openTarget() {
      var t = location.hash && document.getElementById(location.hash.slice(1));
      if (t && t.tagName === "DETAILS") t.open = true;
    }
    window.addEventListener("hashchange", openTarget);
    openTarget();

    document.addEventListener("keydown", function (e) {
      var k = key(e);
      if (k === "search") {
        e.preventDefault();
        var cmd = document.getElementById("cmd");
        if (cmd) { closeAll(); openers.cmd = document.activeElement; toggle(cmd, true); }
      } else if (k === "close") closeAll();
    });
  }

  if (typeof document !== "undefined" && document.addEventListener) {
    if (document.readyState === "loading" || document.readyState === undefined) document.addEventListener("DOMContentLoaded", wire);
    else wire();
  }
})();
