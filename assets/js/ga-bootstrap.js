/* =================================================================
   GA4 (Firebase Google Analytics) bootstrap.

   Reads the Measurement ID from <meta name="ga-measurement-id">. If it is a
   real "G-XXXXXXXX" id, this loads gtag.js and initializes GA4. While the
   placeholder is in place it is a complete no-op, so the site works with or
   without analytics configured (same pattern as recaptcha-bootstrap.js).

   To enable: in Firebase console → your project → Analytics, grab the GA4
   "Measurement ID" (looks like G-XXXXXXXX) and paste it into the
   <meta name="ga-measurement-id"> content in index.html / referral.html.
================================================================= */
(function () {
  'use strict';
  // Never run on local/dev hosts so test visits don't pollute GA4.
  var host = location.hostname;
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '' ||
    host.endsWith('.local')
  ) {
    return;
  }

  var meta = document.querySelector('meta[name="ga-measurement-id"]');
  var id = meta && meta.content ? meta.content.trim() : '';
  // Placeholder or unset -> do nothing.
  if (!id || id.indexOf('G-') !== 0) return;

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () {
    window.dataLayer.push(arguments);
  };
  window.gtag('js', new Date());
  // anonymize_ip + no ad signals: privacy-friendly, matches our IP-hashing posture.
  window.gtag('config', id, { anonymize_ip: true, allow_google_signals: false });

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
  document.head.appendChild(s);
})();
