/* CHG-170: light/dark theme for Milliway. Default stays dark. Choice is stored only in this browser (aff-nest-theme). */
(function () {
  var KEY = 'aff-nest-theme';
  function isLight() {
    return document.documentElement.getAttribute('data-theme') === 'light';
  }
  function sync(btn) {
    var light = isLight();
    btn.setAttribute('aria-pressed', light ? 'true' : 'false');
    btn.setAttribute('aria-checked', light ? 'true' : 'false');
    btn.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
    var lab = btn.querySelector('.theme-toggle-label');
    if (lab) lab.textContent = light ? 'Dark' : 'Light';
  }
  function apply(light, persist) {
    if (light) document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    if (persist) {
      try { localStorage.setItem(KEY, light ? 'light' : 'dark'); } catch (e) {}
    }
    var list = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < list.length; i++) sync(list[i]);
  }
  try {
    if (localStorage.getItem(KEY) === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  } catch (e) {}
  function bind() {
    var list = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < list.length; i++) {
      var btn = list[i];
      if (btn.getAttribute('data-theme-bound')) continue;
      btn.setAttribute('data-theme-bound', '1');
      btn.addEventListener('click', function () { apply(!isLight(), true); });
      sync(btn);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
