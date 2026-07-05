const CACHE_NAME = 'whatsapp-secure-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/manifest.json'
];

// تثبيت ملفات الخدمة وحفظ الملفات الأساسية مؤقتاً
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('📦 PWA Service Worker: Caching Shell Assets');
      return cache.addAll(ASSETS).catch(err => console.warn('Cache addAll warning:', err));
    })
  );
  self.skipWaiting();
});

// تفعيل ملفات الخدمة وتنظيف الكاش القديم
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('🗑️ PWA Service Worker: Clearing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// استرجاع الموارد (استراتيجية الشبكة أولاً مع الرجوع للكاش عند انقطاع الاتصال)
self.addEventListener('fetch', (e) => {
  // تخطي أي طلبات غير GET (مثل إرسال الرسائل عبر REST أو Socket.io)
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // تخطي أي طلبات تخص الـ API والـ WebSockets ونقاط الفحص الفورية
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io') || url.pathname.includes('/health')) {
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // تحديث الكاش بالاستجابة الجديدة الناجحة
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(e.request, resClone);
        });
        return res;
      })
      .catch(() => {
        // في حال فشل الشبكة، نقوم بالرجوع للمطابقة في الكاش المحلي
        return caches.match(e.request).then((cachedRes) => {
          return cachedRes || Promise.reject('no-match-in-cache');
        });
      })
  );
});
