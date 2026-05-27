/**
 * Lazy-load Google reCAPTCHA v3 — only if a real site key is configured.
 *
 * The site key lives in <meta name="recaptcha-site-key" content="..."> in
 * index.html. Until that placeholder is replaced with a real key, this
 * script is a no-op, so the site works fine without reCAPTCHA configured.
 *
 * Extracted from an inline <script> so the CSP can drop 'unsafe-inline'
 * from script-src.
 */
(function () {
  'use strict';
  var meta = document.querySelector('meta[name="recaptcha-site-key"]');
  var key = meta && meta.content;
  if (!key || key.indexOf('YOUR_') === 0) return;

  var s = document.createElement('script');
  s.src = 'https://www.google.com/recaptcha/api.js?render=' + encodeURIComponent(key);
  s.async = true;
  s.defer = true;
  document.head.appendChild(s);
})();
