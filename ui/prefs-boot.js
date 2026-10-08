// Runs before the stylesheets: applies the last choice so the page does not flash. The rest is in prefs.js.
(function () {
  try {
    var p = JSON.parse(localStorage.getItem("scf.prefs"));
    var last = p && p.v === 1 && p.last;
    if (!last) return;
    var root = document.documentElement;
    if (last.theme === "light" || last.theme === "dark") root.setAttribute("data-theme", last.theme);
    if (last.density === "compact") root.setAttribute("data-density", "compact");
  } catch (e) {
    // no storage or broken data: System and Comfortable
  }
})();
