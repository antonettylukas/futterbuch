// Futterbuch Service Worker: App-Dateien offline verfügbar halten. Daten (GitHub, Open Food Facts) nie cachen.
const V="futterbuch-v3";
const SHELL=["./","index.html","app.js","manifest.webmanifest","icon-192.png","icon-512.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=="GET"||u.origin!==location.origin)return;
  // Netz zuerst (damit Updates sofort ankommen), offline aus dem Cache
  e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(V).then(ca=>ca.put(e.request,c));return r}).catch(()=>caches.match(e.request,{ignoreSearch:true}).then(r=>r||caches.match("index.html"))));
});
