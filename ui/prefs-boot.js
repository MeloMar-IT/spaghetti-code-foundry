// Runs before the stylesheets: applies the last choice so the page does not flash. The rest is in prefs.js.
(function () {
  var root;
  try {
    root = document.documentElement;
    // the default look, also when storage is missing or broken
    root.setAttribute("data-look", "calm");
  } catch (e) {
    return;
  }
  try {
    var p = JSON.parse(localStorage.getItem("scf.prefs"));
    var last = p && p.v === 1 && p.last;
    if (!last) return;
    if (last.theme === "light" || last.theme === "dark") root.setAttribute("data-theme", last.theme);
    if (last.density === "compact") root.setAttribute("data-density", "compact");
    if (["calm", "midnight", "friendly", "editorial", "bento"].indexOf(last.look) >= 0) root.setAttribute("data-look", last.look);
  } catch (e) {
    // no storage or broken data: System, Comfortable and Calm
  }
})();
