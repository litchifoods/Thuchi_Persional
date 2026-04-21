// ================================================================
//  SERVICE WORKER — Thu Chi Cá Nhân PWA
//  Phiên bản: 1.0
//  Chức năng: Cache tĩnh để app hoạt động offline + tải nhanh hơn
// ================================================================

const CACHE_NAME = 'thu-chi-v1';

// Các file sẽ được cache để dùng offline
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './config.js'
];

// ----------------------------------------------------------------
//  CÀI ĐẶT: Cache các file tĩnh khi SW được cài lần đầu
// ----------------------------------------------------------------
self.addEventListener('install', event => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Caching static assets');
      return cache.addAll(STATIC_ASSETS);
    })
  );
  // Kích hoạt ngay lập tức, không chờ tab cũ đóng
  self.skipWaiting();
});

// ----------------------------------------------------------------
//  KÍCH HOẠT: Xóa cache cũ khi có phiên bản mới
// ----------------------------------------------------------------
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    )
  );
  // Nhận quyền kiểm soát tất cả tab ngay lập tức
  self.clients.claim();
});

// ----------------------------------------------------------------
//  FETCH: Chiến lược "Cache First, Network Fallback"
// ----------------------------------------------------------------
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // KHÔNG cache các request tới Google APIs (GAS, Gemini, Telegram)
  // Các request này cần kết nối mạng thực sự
  const isApiCall = (
    url.hostname.includes('script.google.com') ||
    url.hostname.includes('script.googleusercontent.com') ||
    url.hostname.includes('generativelanguage.googleapis.com') ||
    url.hostname.includes('api.telegram.org')
  );

  if (isApiCall) {
    // Bypass cache hoàn toàn cho API calls
    event.respondWith(fetch(event.request));
    return;
  }

  // Với file tĩnh: thử cache trước, nếu không có thì lấy từ mạng
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      if (cachedResponse) {
        // Có cache → trả về cache, đồng thời cập nhật cache ngầm
        fetch(event.request).then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, networkResponse);
            });
          }
        }).catch(() => {}); // Bỏ qua lỗi mạng khi update ngầm
        return cachedResponse;
      }

      // Không có cache → lấy từ mạng
      return fetch(event.request).then(networkResponse => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type === 'opaque') {
          return networkResponse;
        }
        // Cache lại để dùng lần sau
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseToCache);
        });
        return networkResponse;
      });
    })
  );
});
