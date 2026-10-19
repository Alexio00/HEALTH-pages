const RELEASE = "5e24b2e7935e2fac9cd894f19662966ef5130bd9-pages-recovery-r1";
const FILE_HASHES = {"./index.html":"5fe4f9ae59828d9ce043a22fa9619e40bd0cfa1828b8e0ed588e4b0a15fe6be8","./styles.css":"ea07a8b8481020e835f90041e2f503bd3aa484dfbd0816fea91fa484bbe8a067","./app.js":"9dda0b57e86985cb2cb3e392171c2e7f8409a3fa6544b5dd005abdfdf2600ac6","./vaccination.mjs":"91e14fb8503f2bb29507d002e5b86cda33ddd9346debb381ac372b5d5f5019b6","./supabase-client.js":"56a533ab38e1d81d68c08f857acaf0243c6c45f2f3f0d329df714206d3d5d713","./config.js":"e1a22f654206bb5330bf76009935a454722e8a93436d40ab0382cc6bea2c615d","./manifest.webmanifest":"1ec85cfa6f114fe9c93627142dd203eaf5a61a1a91f10debf7a86b83a6cc1d5e","./icon.svg":"fd0f6fa5eebf4a835f353456bdc6727d182097b18d1e2fc8f2b67256122bd541"};
const CACHE = "health-shell-" + RELEASE;
const SHELL = ["./index.html", "./styles.css", "./app.js", "./vaccination.mjs",
  "./supabase-client.js", "./config.js", "./manifest.webmanifest", "./icon.svg"];
const BASE = new URL("./", self.location.href);
const STATIC = new Set(SHELL.map(path => new URL(path, BASE).href));

function cacheKey(request) {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== BASE.origin || url.search ||
      request.headers.has("authorization") || request.headers.has("range")) return null;
  url.hash = "";
  if (url.href === BASE.href) url.pathname += "index.html";
  return STATIC.has(url.href) ? url.href : null;
}

function safeResponse(response, key) {
  if (response.status !== 200 || response.redirected || response.type === "opaque" ||
      (response.url && response.url !== key)) return false;
  const control = response.headers.get("cache-control") || "";
  const vary = response.headers.get("vary") || "";
  if (/\b(no-store|private|no-cache)\b/i.test(control) || /(?:\*|authorization|cookie)/i.test(vary)) return false;
  const mime = (response.headers.get("content-type") || "").split(";")[0].trim();
  if (key.endsWith(".html")) return mime === "text/html";
  if (/\.(js|mjs)$/.test(key)) return /^(text|application)\/javascript$/.test(mime);
  if (key.endsWith(".css")) return mime === "text/css";
  if (key.endsWith(".webmanifest")) return /^(application\/manifest\+json|application\/json)$/.test(mime);
  if (key.endsWith(".svg")) return mime === "image/svg+xml";
  return false;
}

async function verifiedResponse(response, key) {
  if (!safeResponse(response, key)) return false;
  const relative = "./" + new URL(key).pathname.slice(BASE.pathname.length);
  const expected = FILE_HASHES[relative];
  if (!expected) return !/^[0-9a-f]{40}$/.test(RELEASE) && Object.keys(FILE_HASHES).length === 0; // local synthetic/dev source only
  const bytes = await response.clone().arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  return actual === expected;
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const fetched = [];
    for (const path of SHELL) {
      const key = new URL(path, BASE).href;
      const response = await fetch(key, { cache: "reload", credentials: "omit", redirect: "error" });
      if (!await verifiedResponse(response, key)) throw new Error("Unsafe or mismatched shell response");
      fetched.push([key, response]);
    }
    for (const [key, response] of fetched) await cache.put(key, response);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith("health-shell-") && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const key = cacheKey(event.request);
  if (!key) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // A built worker serves one complete release; a new install changes CACHE.
    const existing = await cache.match(key);
    if (existing && FILE_HASHES["./" + new URL(key).pathname.slice(BASE.pathname.length)]) return existing;
    try {
      const response = await fetch(key, { credentials: "omit", redirect: "error" });
      if (!await verifiedResponse(response, key)) throw new Error("Release response rejected");
      await cache.put(key, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(key);
      if (cached) return cached;
      throw error;
    }
  })());
});
