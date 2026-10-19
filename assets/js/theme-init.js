// Runs before first paint: applies the saved theme (no flash) and refuses to render inside a frame
// (clickjacking defence — GitHub Pages can't send X-Frame-Options / frame-ancestors headers).
(function () {
  'use strict';
  var root = document.documentElement;
  try {
    var p = JSON.parse(localStorage.getItem('d2m-prefs') || '{}');
    if (p.theme === 'light' || p.theme === 'dark') root.dataset.theme = p.theme;
  } catch (e) {}
  if (window.top !== window.self) {
    root.classList.add('framed');
    try { window.top.location.replace(window.self.location.href); } catch (e) {}
  }
})();
