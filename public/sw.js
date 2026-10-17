/* 离线 Service Worker：缓存应用壳 + 词表 + 模型文件，首次联网加载后可离线用。
 * 策略：
 * - 导航（HTML）：network-first，离线时回退缓存（HTML 在 nginx 仍是 no-store，联网时每次都取新的）。
 * - /models/ 与 .wasm/.onnx（模型文件，不可变）：cache-first，联网时后台更新缓存。
 * - 其它同源 GET（JS/CSS/词表/图片）：stale-while-revalidate。
 * - /api/（在线词典/音频反代）：不缓存，直接走网络（离线时由应用内本地词表 + TTS 兜底）。
 * - /data/audio/（打包的真人语音）：不缓存。APK 内音频已是本地文件，SW 再缓存会重复占 200MB+ 存储；
 *   网页版无音频文件，不缓存也不影响。App 通过 manifest.json 判断本地是否有音频。
 * - 只处理同源 GET；POST/跨域直接放行。
 */
const CACHE = 'ept-offline-v1';
const PRECACHE = ['./', './index.html', './manifest.webmanifest', './data/cet4.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/api/')) return;
  if (url.pathname.includes('/data/audio/')) return; // 打包真人语音：APK 内已是本地文件，SW 不重复缓存
  // 热更新文件（Capacitor convertFileSrc 的 /_capacitor_file_/ URL）：由原生层直接供文件，
  // SW 绝不拦截/缓存，否则同路径的新版热更新会被 SW 缓存的旧版遮挡。
  if (url.pathname.startsWith('/_capacitor_file_/')) return;

  if (request.mode === 'navigate') {
    // 导航：联网优先，离线回退缓存
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }

  const isModel =
    url.pathname.startsWith('/models/') ||
    url.pathname.endsWith('.wasm') ||
    url.pathname.endsWith('.onnx');
  if (isModel) {
    // 模型文件：缓存优先（首次下载后离线可用）
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        });
      }),
    );
    return;
  }

  // 其它同源静态资源：缓存优先，后台更新
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
