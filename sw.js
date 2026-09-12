/* Pillier Service Worker — app-shell offline support.
 *
 * Safe-by-design:
 *  - Network-FIRST for HTML/navigation, so online users ALWAYS get the latest
 *    app (no "stuck on a stale version" footgun); the cached shell is served
 *    only when the network is unavailable.
 *  - Cache-first for static shell + CDN assets (fonts, DOMPurify, supabase-js),
 *    so the app can boot with no connection.
 *  - It NEVER intercepts auth, data, or AI calls (Supabase, /api/*, Gemini,
 *    Groq). Those always go straight to the network, live.
 *  - Non-GET requests are never touched.
 *  Bumping VERSION invalidates every old cache on activate.
 */
var VERSION = 'pillier-v4';
var SHELL   = VERSION + '-shell';
var RUNTIME = VERSION + '-runtime';

// Same-origin static assets that make up the installable shell.
var SHELL_URLS = ['/', '/index.html', '/manifest.json'];

// Cross-origin CDNs whose assets the shell needs to render offline.
var CDN_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];

// Hosts/paths we must NEVER intercept — auth + data + AI must always be live.
function isBypass(url) {
  return /supabase/.test(url.hostname)
      || url.pathname.indexOf('/api/') === 0
      || /generativelanguage\.googleapis\.com$/.test(url.hostname)
      || /(^|\.)groq\.com$/.test(url.hostname);
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL).then(function (c) {
      // Cache each URL independently: cache.addAll() is atomic, so one failing
      // request would leave the whole shell uncached and break offline load.
      // We also fetch index.html explicitly and store it under both keys so a
      // cold first-visit (before the fetch handler ever runs) is still covered.
      return Promise.all(SHELL_URLS.map(function (u) {
        return fetch(u, { cache: 'no-cache' }).then(function (res) {
          if (res && res.ok) return c.put(u, res.clone());
        }).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k.indexOf(VERSION) !== 0) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                 // never touch writes
  var url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (isBypass(url)) return;                         // auth/data/AI → straight to network

  // Navigation / HTML → network-first (fresh app online, cached shell offline).
  var accept = req.headers.get('accept') || '';
  if (req.mode === 'navigate' || accept.indexOf('text/html') >= 0) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          // Keep both shell keys warm so either the PWA start_url ('/') or a
          // deep link ('/index.html') can be served on the next offline launch.
          try {
            caches.open(SHELL).then(function (c) {
              c.put('/index.html', res.clone());
              c.put('/', res.clone());
            });
          } catch (_) {}
        }
        return res;
      }).catch(function () {
        return caches.match('/index.html')
          .then(function (m) { return m || caches.match('/'); })
          .then(function (m) { return m || caches.match(req); });
      })
    );
    return;
  }

  var sameOrigin = url.origin === self.location.origin;
  var isCDN = CDN_HOSTS.indexOf(url.hostname) >= 0;
  if (!sameOrigin && !isCDN) return;                // unknown cross-origin → passthrough

  // Static assets → cache-first, then network (and cache the result).
  e.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        try {
          if (res && (res.ok || res.type === 'opaque')) {
            var copy = res.clone();
            caches.open(RUNTIME).then(function (c) { c.put(req, copy); });
          }
        } catch (_) {}
        return res;
      }).catch(function () { return cached; });
    })
  );
});
