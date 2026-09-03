const SW_VERSION = 'ayla-pwa-premium-v9';
const SHELL_CACHE = `${SW_VERSION}-shell`;
const DATA_CACHE = `${SW_VERSION}-data`;
// هذا الكاش ثابت حتى لا تُحذف صور المنتجات عند تحديث الواجهة أو Service Worker.
const IMAGE_CACHE = 'ayla-images-v1';
const IMAGE_MANIFEST_REQUEST = new Request('./__ayla-image-manifest__.json');
const MAX_IMAGE_ENTRIES = 4000;
const ACTIVE_CACHES = new Set([SHELL_CACHE, DATA_CACHE, IMAGE_CACHE]);
const APP_SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith('ayla-') && !ACTIVE_CACHES.has(key)).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'SYNC_IMAGE_URLS') event.waitUntil(syncImageManifest(event.data.urls));
  if (event.data?.type === 'PREFETCH_IMAGES') event.waitUntil(prefetchImages(event.data.urls));
});

async function fetchWithTimeout(request, timeoutMs = 4000){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(request, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function networkFirst(request, cacheName, fallback){
  const cache = await caches.open(cacheName);
  try {
    const response = await fetchWithTimeout(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    return (await cache.match(request)) || (fallback ? await caches.match(fallback) : undefined) || Response.error();
  }
}

async function cacheFirst(request, cacheName){
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request, cacheName){
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request).then(response => {
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || (await network) || Response.error();
}

function validImageUrl(value){
  try { const url = new URL(value); return url.protocol === 'https:'; } catch { return false; }
}

async function syncImageManifest(urls){
  const unique = [...new Set((Array.isArray(urls) ? urls : []).filter(validImageUrl))].slice(0, MAX_IMAGE_ENTRIES);
  const cache = await caches.open(IMAGE_CACHE);
  await cache.put(IMAGE_MANIFEST_REQUEST, new Response(JSON.stringify({ urls: unique, savedAt: Date.now() }), { headers: { 'Content-Type': 'application/json' } }));
  const current = new Set(unique);
  const keys = await cache.keys();
  const removable = keys.filter(request => request.url !== IMAGE_MANIFEST_REQUEST.url && !current.has(request.url));
  await Promise.all(removable.map(request => cache.delete(request)));
  const remaining = (await cache.keys()).filter(request => request.url !== IMAGE_MANIFEST_REQUEST.url);
  if (remaining.length > MAX_IMAGE_ENTRIES) await Promise.all(remaining.slice(0, remaining.length - MAX_IMAGE_ENTRIES).map(request => cache.delete(request)));
}

async function prefetchImages(urls){
  // لا يوجد سقف اصطناعي على عدد الصور — تُجلب كل صور الكتالوج (حتى حد MAX_IMAGE_ENTRIES).
  const unique = [...new Set((Array.isArray(urls) ? urls : []).filter(validImageUrl))].slice(0, MAX_IMAGE_ENTRIES);
  const cache = await caches.open(IMAGE_CACHE);
  let index = 0;
  const CONCURRENCY = 8; // عدد الصور التي تُجلب بالتوازي بدل واحدة تلو الأخرى
  async function worker(){
    while (index < unique.length){
      const url = unique[index++];
      if (await cache.match(url)) continue; // موجودة أصلاً، تخطّيها
      try { const response = await fetch(url, { mode: 'no-cors', credentials: 'omit' }); if (response.ok || response.type === 'opaque') await cache.put(url, response.clone()); }
      catch { /* التحميل المسبق اختياري ولا يعطل المتجر */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.pathname.endsWith('/api/catalog-v2.json')) { event.respondWith(networkFirst(request, DATA_CACHE)); return; }
  if (request.destination === 'image' || url.pathname.includes('/manus-storage/')) { event.respondWith(cacheFirst(request, IMAGE_CACHE)); return; }
  if (request.mode === 'navigate') { event.respondWith(networkFirst(request, SHELL_CACHE, './index.html')); return; }
  if (url.origin === self.location.origin) event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text?.() || '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'ايلا ستورز', {
    body: data.body || 'يوجد تحديث جديد في متجر ايلا.', icon: data.icon || './icon-192.png', badge: data.badge || './icon-192.png',
    dir: 'rtl', lang: 'ar', renotify: false, data: { url: data.url || './index.html' }, tag: data.tag || 'ayla-store-update'
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || './index.html';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const sameOrigin = list.find(client => new URL(client.url).origin === self.location.origin);
    if (sameOrigin) return sameOrigin.focus().then(() => sameOrigin.navigate(target));
    return clients.openWindow(target);
  }));
});
