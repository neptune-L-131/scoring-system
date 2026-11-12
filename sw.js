// sw.js —— 整版缓存 + 温和更新
//
// 设计要点（保证用户永远看到“内部一致的整版”）：
// 1) 版本标识即缓存名：CACHE = 'score-sys-' + VERSION。一个 SW 实例只读自己版本的缓存，
//    绝不跨版本读取，所以不存在“旧代码拿到新模块”或相反的情况。
// 2) 整版下载：install 时用 cache.addAll 把清单里所有文件一次性写入新缓存。
//    任一请求失败 → install 失败 → 新版本被丢弃，旧版本继续完整服务（不会激活半个版本）。
// 3) 下载与激活分离：install 不调用 skipWaiting。新版本进入 waiting，
//    已打开的页面仍由旧 SW 用旧缓存服务；等到所有页面关闭，浏览器才激活新版本。
//    因此“第一次访问看到旧版、第二次访问看到新版”，且全程不打断用户。
// 4) 不写入清单外的响应：fetch 命中缓存即返回；未命中只透传网络，不回写缓存，
//    避免把线上的新版文件塞进旧版缓存。
// 5) activate 时删除其它 score-sys-* 缓存（含旧的 blob SW 留下的 score-sys-v1）。
//
// 发版流程（无构建步骤）：改了任何前端文件后，把下面的 VERSION 手动 +1 再 push。
// tests/sw-assets.test.js 会校验：清单与仓库实际文件一致、VERSION 与缓存名一致。
'use strict';

const VERSION = '2026-11-12.5';
const CACHE = 'score-sys-' + VERSION;

// 整版清单（相对 sw.js 所在目录）
const PRECACHE = [
  './index.html',
  './style.css',
  './main.js',
  './src/constants.js',
  './src/time.js',
  './src/pure.js',
  './src/entity-kit.js',
  './src/entity-convert.js',
  './src/defaults.js',
  './src/toast.js',
  './src/cond-model.js',
  './src/modal-host.js',
  './src/render.js',
  './src/state.js',
  './src/theme.js',
  './src/normalize.js',
  './src/persist.js',
  './src/utils.js',
  './src/stats.js',
  './src/ledger.js',
  './src/gate.js',
  './src/budget.js',
  './src/budget-binding.js',
  './src/conditions.js',
  './src/entities.js',
  './src/business.js',
  './src/library.js',
  './src/shell.js',
  './src/render-work.js',
  './src/render-bank.js',
  './src/render-shop.js',
  './src/render-budget.js',
  './src/cycle.js',
  './src/cond-ui.js',
  './src/ui-events.js',
  './src/undo.js',
  './src/modals.js',
  './src/data.js',
  './src/pwa.js',
  './src/debug.js',
  './src/startup.js',
];

function abs(rel) {
  return new URL(rel, self.registration.scope).href;
}

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(CACHE);
    // cache:'reload' 绕过 HTTP 缓存，确保这次装进去的是一整套同版本的字节
    const reqs = PRECACHE.map(function (u) {
      return new Request(abs(u), { cache: 'reload' });
    });
    await cache.addAll(reqs); // 任一失败 → install 失败 → 新版本不激活
    // 刻意不调用 skipWaiting()
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.map(function (k) {
      if (k !== CACHE && k.indexOf('score-sys-') === 0) return caches.delete(k);
      return null;
    }));
    await self.clients.claim();
  })());
});

// 页面在“自己是旧版、新版本已下载完成”时发来 SKIP_WAITING：
// 立即激活新版本，但当前页面保持运行已加载的旧代码，所以用户看不到任何中断；
// 下一次打开（导航请求）就由新版本整版服务。这样“第二次访问必定是新版”不依赖
// 用户是否真的关掉了所有标签页。
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  // 导航请求：一律返回本版本的 index.html（整版入口）
  if (req.mode === 'navigate') {
    event.respondWith((async function () {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(abs('./index.html'), { ignoreSearch: true });
      if (hit) return hit;
      try { return await fetch(req); }
      catch (e) { return new Response('离线且无缓存', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }
    })());
    return;
  }

  // 静态资源：只从本版本缓存取；未命中则透传网络且不回写（避免混版）
  event.respondWith((async function () {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try { return await fetch(req); }
    catch (e) { return new Response('', { status: 504 }); }
  })());
});
