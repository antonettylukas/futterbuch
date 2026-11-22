/* Futterbuch – Ernährungstagebuch als installierbare Web-App.
   Daten liegen lokal (IndexedDB) und werden mit einem privaten GitHub-Repo abgeglichen.
   Dateiformat im Repo: {"version":1,"recs":{<schluessel>:{...,"u":<ms>}}}
   Abgleich pro Datensatz: der mit dem größeren "u" gewinnt; Löschen = {"del":true}. */
"use strict";
const VERSION = "23 (22.11.)";
const DEF_REPO = "antonettylukas/futterbuch-_daten";
const MEALS = [["frueh","Frühstück"],["mittag","Mittag"],["snack","Snack"],["abend","Abend"],["extra","Sonstiges"]];
const MEALNAME = Object.fromEntries(MEALS);
const WD = ["So","Mo","Di","Mi","Do","Fr","Sa"];
const OFF = "https://world.openfoodfacts.org";
const OFF_FIELDS = "code,product_name,product_name_de,generic_name,brands,quantity,serving_quantity,nutriments";

/* ---------- kleine Helfer ---------- */
const $ = s => document.querySelector(s);
function iso(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")}
function today(){return iso(new Date())}
function addDays(s,n){const d=new Date(s+"T12:00:00");d.setDate(d.getDate()+n);return iso(d)}
function nowHM(){const d=new Date();return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0")}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function num(v){if(v===""||v==null)return NaN;return parseFloat(String(v).replace(",","."))}
function r0(x){return Math.round(x||0)}
function r1(x){return (Math.round((x||0)*10)/10).toLocaleString("de-CH")}
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,6)}
function norm(s){return String(s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"")}
const month = d => d.slice(0,7);

/* ---------- IndexedDB ---------- */
const kv = (()=>{let p;
  const open=()=>p||(p=new Promise((res,rej)=>{const r=indexedDB.open("futterbuch",1);r.onupgradeneeded=()=>r.result.createObjectStore("kv");r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)}));
  const tx=async(mode,fn)=>{const db=await open();return new Promise((res,rej)=>{const t=db.transaction("kv",mode);const st=t.objectStore("kv");const r=fn(st);t.oncomplete=()=>res(r&&r.result);t.onerror=()=>rej(t.error)})};
  return {get:k=>tx("readonly",s=>s.get(k)),set:(k,v)=>tx("readwrite",s=>s.put(v,k)),keys:()=>tx("readonly",s=>s.getAllKeys())};
})();

/* ---------- Dateien (lokal + Repo) ---------- */
const F = {};          // pfad -> {recs, sha, dirty}
async function file(path){
  if(!F[path]) F[path] = (await kv.get("f:"+path)) || {recs:{},sha:null,dirty:false};
  return F[path];
}
async function saveFile(path){await kv.set("f:"+path,F[path])}
const P = {
  lm: "lebensmittel.json",
  kg: "gewicht.json",
  rz: "rezepte.json",
  plan: d => "plan/"+month(d)+".json",
  log: d => "tagebuch/"+month(d)+".json",
};
async function putRec(path,key,rec){
  const f = await file(path);
  const old = f.recs[key];
  f.recs[key] = {...rec, u: Math.max(Date.now(), (old&&old.u||0)+1)};
  f.dirty = true;
  await saveFile(path);
  render(); scheduleSync(1500);
}
const live = recs => Object.entries(recs||{}).filter(([,r])=>r&&!r.del);

/* ---------- Zustand ---------- */
const S = {date:today(), tab:"tag", lmQuery:"", cfg:{repo:DEF_REPO,token:""}, sync:{state:"local",msg:"",last:null}};

function foods(){return F[P.lm]?F[P.lm].recs:{}}
function food(id){const f=foods()[id];return f&&!f.del?f:null}
function foodName(id){const f=food(id);return f?f.name:"Unbekannt ("+id+")"}
function nut(lm,g){const f=food(lm);const z={kcal:0,p:0,kh:0,f:0,bst:0};if(!f)return z;const x=g/100;for(const k in z)z[k]=(Number(f[k])||0)*x;return z}
function sum(items){const t={kcal:0,p:0,kh:0,f:0,bst:0};for(const it of items){const n=nut(it.lm,it.g);for(const k in t)t[k]+=n[k]}return t}
function dayPlan(d){const f=F[P.plan(d)];const r=f&&f.recs[d];return r&&!r.del?r:null}
function dayLog(d){const f=F[P.log(d)];return f?live(f.recs).filter(([,e])=>e.d===d).map(([id,e])=>({id,...e})).sort((a,b)=>(a.t||"").localeCompare(b.t||"")||(a.id<b.id?-1:1)):[]}

/* ---------- GitHub-Abgleich ---------- */
function b64enc(str){const bytes=new TextEncoder().encode(str);let bin="";for(let i=0;i<bytes.length;i+=0x8000)bin+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));return btoa(bin)}
function b64dec(b){const bin=atob(b.replace(/\s/g,""));return new TextDecoder().decode(Uint8Array.from(bin,c=>c.charCodeAt(0)))}
async function gh(method,path,body){
  const r = await fetch("https://api.github.com/repos/"+S.cfg.repo+"/contents/"+path,{
    method, cache:"no-store",
    headers:{Authorization:"Bearer "+S.cfg.token,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28",...(body?{"Content-Type":"application/json"}:{})},
    body: body?JSON.stringify(body):undefined});
  return r;
}
function merge(a,b){
  const out={...a};let changed=false;
  for(const [k,rb] of Object.entries(b||{})){const ra=out[k];if(!ra||(rb.u||0)>(ra.u||0)){out[k]=rb;changed=true}}
  return {recs:out,changed};
}
function sameRecs(a,b){const ka=Object.keys(a),kb=Object.keys(b||{});if(ka.length!==kb.length)return false;for(const k of ka){if(!b[k]||(b[k].u||0)!==(a[k].u||0))return false}return true}
async function syncFile(path){
  const local = await file(path);
  for(let attempt=0;attempt<3;attempt++){
    const r = await gh("GET",path);
    let remote=null, sha=null;
    if(r.status===404){remote={};}
    else if(!r.ok){throw new Error(r.status===401?"Schlüssel ungültig oder abgelaufen":r.status===403?"Kein Zugriff aufs Repo (Schlüssel-Rechte prüfen)":"GitHub antwortet "+r.status)}
    else{const j=await r.json();sha=j.sha;try{remote=JSON.parse(b64dec(j.content)).recs||{}}catch(e){throw new Error(path+" ist kein gültiges JSON")}}
    const m1 = merge(local.recs, remote);           // Remote-Neues nach lokal
    if(m1.changed){local.recs=m1.recs;await saveFile(path);render()}
    const needPush = !sameRecs(local.recs, remote);
    if(!needPush){local.sha=sha;local.dirty=false;await saveFile(path);return}
    const content = b64enc(JSON.stringify({version:1,recs:local.recs},null,1)+"\n");
    const w = await gh("PUT",path,{message:"App: "+path,content,...(sha?{sha}:{})});
    if(w.ok){const j=await w.json();local.sha=j.content.sha;local.dirty=false;await saveFile(path);return}
    if(w.status===409||w.status===422)continue;  // jemand hat zwischendurch geschrieben: neu lesen und mergen
    throw new Error(w.status===403||w.status===404?"Schreiben verweigert (Schlüssel braucht Contents: Read and write)":"Speichern bei GitHub: "+w.status);
  }
  throw new Error("Konflikt bei "+path+", nächster Versuch gleich");
}
let syncTimer=null, syncing=false, syncAgain=false;
function scheduleSync(ms){clearTimeout(syncTimer);syncTimer=setTimeout(syncAll,ms)}
async function syncAll(){
  if(!S.cfg.token){setSync("local");return}
  if(!navigator.onLine){setSync("offline");return}
  if(syncing){syncAgain=true;return}
  syncing=true;setSync("busy");
  try{
    const paths=new Set([P.lm,P.kg,P.rz,P.plan(S.date),P.log(S.date),P.plan(today()),P.log(today()),P.plan(addDays(today(),7)),...Object.keys(F)]);
    for(const p of paths) await syncFile(p);
    S.sync.last=new Date();setSync("ok");
  }catch(e){setSync("err",e.message||String(e))}
  syncing=false;
  if(syncAgain){syncAgain=false;scheduleSync(500)}
}
function setSync(state,msg){
  S.sync.state=state;S.sync.msg=msg||"";
  const el=$("#sync");el.className="sync "+({ok:"ok",busy:"pending",err:"err",local:"pending",offline:"pending"}[state]||"");
  const pending=Object.values(F).some(f=>f.dirty);
  const t={local:"Nur auf diesem Handy gespeichert. Unter „Sync“ mit GitHub verbinden.",busy:"Gleiche mit GitHub ab …",
    ok:"Abgeglichen "+(S.sync.last?S.sync.last.toLocaleTimeString("de-CH",{hour:"2-digit",minute:"2-digit"}):""),
    err:"Abgleich fehlgeschlagen: "+S.sync.msg+(pending?" · Änderungen sind lokal sicher":""),
    offline:"Offline · Änderungen werden später abgeglichen"}[state];
  el.querySelector("span").textContent=t;
  if(S.tab==="sync")renderSync();
}

/* ---------- Tag ---------- */
function renderTag(){
  const v=$("#v-tag");
  const d=new Date(S.date+"T12:00:00");
  $("#titel").firstChild.nodeValue=(S.date===today()?"Heute":WD[d.getDay()]+" "+d.getDate()+"."+(d.getMonth()+1)+".");
  const plan=dayPlan(S.date);
  $("#untertitel").textContent=plan&&plan.titel?plan.titel:d.toLocaleDateString("de-CH",{weekday:"long",day:"numeric",month:"long"});
  const entries=dayLog(S.date);
  const ist=sum(entries);
  const z=plan&&plan.ziele;
  const bar=(val,goal,col)=>`<div class="bar"><i style="width:${goal?Math.min(100,val/goal*100):0}%;background:${col}"></i></div>`;
  const makro=(lbl,k,col)=>`<div class="makro"><span class="lbl">${lbl}</span>${bar(ist[k],z&&z[k],col)}<span class="val num">${r0(ist[k])}${z&&z[k]?"/"+r0(z[k]):""} g</span></div>`;
  let rest="";
  if(z&&z.kcal){const r=z.kcal-ist.kcal;rest=`<span class="rest num" style="color:${r<0?"var(--warn)":"var(--ok)"}">${r<0?r0(-r)+" drüber":r0(r)+" offen"}</span>`}
  let html=`<div class="card konto">
    <div class="kcal"><b class="num">${r0(ist.kcal)}</b><span>${z&&z.kcal?"von "+r0(z.kcal)+" kcal":"kcal"}</span>${rest}</div>
    ${bar(ist.kcal,z&&z.kcal,"var(--accent)")}
    <div class="makros">${makro("Protein","p","var(--p)")}${makro("KH","kh","var(--kh)")}${makro("Fett","f","var(--f)")}${makro("Ballast","bst","var(--bst)")}</div>
    ${z?"":'<div class="hint">Für diesen Tag gibt es keinen Plan. Eintragen geht trotzdem.</div>'}
  </div>`;
  const keys=MEALS.map(m=>m[0]);
  for(const [key,label] of MEALS){
    const pm=plan&&(plan.mahlzeiten||[]).find(m=>m.key===key);
    const es=entries.filter(e=>(keys.includes(e.m)?e.m:"extra")===key);
    if(key==="extra"&&!es.length&&!pm)continue;
    const s=sum(es);
    html+=`<article class="card meal"><header><h2>${esc(label)}</h2>${pm&&pm.zeit?`<span class="zeit num">${esc(pm.zeit)}</span>`:""}</header>${mealMacros(s)}`;
    if(pm&&pm.items&&pm.items.length){
      const ps=sum(pm.items);
      html+=`<div class="soll"><span class="t">Plan: ${esc(pm.name||label)} <span class="num">· ${r0(ps.kcal)} kcal · P ${r0(ps.p)} · KH ${r0(ps.kh)} · F ${r0(ps.f)}</span></span>
        <span>${pm.items.map(it=>esc(foodName(it.lm))+" "+r0(it.g)+" g").join(" · ")}</span>
        <button data-plan="${key}">${es.length?"Plan nochmals dazu":"Wie geplant eintragen"}</button></div>`;
    }
    if(es.length) html+=`<ul class="rows">`+es.map(e=>{const n=nut(e.lm,e.g);return `<li><button class="row" data-edit="${esc(e.id)}"><span class="n">${esc(foodName(e.lm))}</span><span class="g num">${r1(e.g)} g</span><span class="m num">${r0(n.kcal)} kcal · P ${r1(n.p)} · KH ${r1(n.kh)} · F ${r1(n.f)}${e.notiz?" · "+esc(e.notiz):""}</span></button></li>`}).join("")+`</ul>`;
    else if(!pm) html+=`<div class="leer">Noch nichts eingetragen.</div>`;
    html+=`<button class="add" data-add="${key}">+ Eintragen</button></article>`;
  }
  v.innerHTML=html;
}
function mealMacros(s){
  const pc=()=>"";
  return `<div class="mm"><span class="mk kc num">${r0(s.kcal)} kcal</span><span class="mk mp num">P ${r0(s.p)}${pc(s.p*4)}</span><span class="mk mkh num">KH ${r0(s.kh)}${pc(s.kh*4)}</span><span class="mk mf num">F ${r0(s.f)}${pc(s.f*9)}</span></div>`;
}
function planToLog(key){
  const pm=(dayPlan(S.date).mahlzeiten||[]).find(m=>m.key===key);if(!pm)return;
  const t=pm.zeit||nowHM();
  (async()=>{const path=P.log(S.date);const f=await file(path);
    for(const it of pm.items){const id=uid();f.recs[id]={d:S.date,m:key,lm:it.lm,g:it.g,t,plan:true,u:Date.now()}}
    f.dirty=true;await saveFile(path);render();scheduleSync(1500)})();
}

/* ---------- Sheets ---------- */
let sheetCleanup=null;
let lockY=0;
function lock(on){const b=document.body;if(on&&!b.classList.contains("locked")){lockY=window.scrollY;b.style.top=-lockY+"px";b.classList.add("locked")}else if(!on&&b.classList.contains("locked")){b.classList.remove("locked");b.style.top="";window.scrollTo(0,lockY)}}
function closeSheet(){if(sheetCleanup){sheetCleanup();sheetCleanup=null}$("#sheetroot").innerHTML="";lock(false)}
function openSheet(inner,onReady){
  closeSheet();
  lock(true);
  $("#sheetroot").innerHTML=`<div class="backdrop" id="bd"><div class="sheet" role="dialog" aria-modal="true">${inner}</div></div>`;
  $("#bd").addEventListener("click",e=>{if(e.target.id==="bd")closeSheet()});
  onReady&&onReady($("#sheetroot .sheet"));
}
function searchFoods(q){
  const ws=norm(q).split(/\s+/).filter(Boolean);
  const arr=live(foods()).map(([id,f])=>({id,...f}));
  const out=ws.length?arr.filter(f=>{const h=norm(f.name+" "+(f.marke||"")+" "+(f.code||""));return ws.every(w=>h.includes(w))}):arr;
  return out.sort((a,b)=>(b.benutzt||0)-(a.benutzt||0)||a.name.localeCompare(b.name,"de"));
}
function foodRows(list,attr){
  if(!list.length)return '<div class="leer" style="padding:12px 14px">Nichts gefunden.</div>';
  return list.slice(0,300).map(f=>`<button class="row" ${attr}="${esc(f.id)}"><span class="n">${esc(f.name)}</span><span class="num">${r0(f.kcal)} kcal</span><span class="m">${esc(f.marke||"")}${f.marke?" · ":""}100 g: P ${r1(f.p)} · KH ${r1(f.kh)} · F ${r1(f.f)}</span></button>`).join("");
}
function addFlow(meal){
  openSheet(`<h2>Eintragen: ${esc(MEALNAME[meal])}</h2>
    <input class="search" id="q" type="search" placeholder="In deinen Lebensmitteln suchen" autocomplete="off">
    <div class="btnrow"><button class="ghost" id="scan" style="flex:1">Barcode</button><button class="ghost" id="off" style="flex:1">Open Food Facts</button><button class="ghost" id="rzb" style="flex:1">Rezept</button></div>
    <div class="list" id="res" style="overflow-y:auto;overscroll-behavior:contain;min-height:120px;flex:1 1 auto"></div>
    <button class="ghost" id="cancel">Abbrechen</button>`,sh=>{
    const q=sh.querySelector("#q"),res=sh.querySelector("#res");
    const draw=()=>{res.innerHTML=foodRows(searchFoods(q.value),"data-pick")};
    draw();q.addEventListener("input",draw);
    res.addEventListener("click",e=>{const b=e.target.closest("[data-pick]");if(b){const f=food(b.dataset.pick);amountSheet({lm:b.dataset.pick,m:meal,g:f.portion||100},null)}});
    sh.querySelector("#scan").onclick=()=>scanSheet(id=>amountSheet({lm:id,m:meal,g:food(id).portion||100},null));
    sh.querySelector("#off").onclick=()=>offSheet(q.value,id=>amountSheet({lm:id,m:meal,g:food(id).portion||100},null));
    sh.querySelector("#rzb").onclick=()=>pickRecipe(rid=>cookSheet(rid,meal),meal);
    sh.querySelector("#cancel").onclick=closeSheet;
  });
}
function amountSheet(entry,id){
  const f=food(entry.lm);
  openSheet(`<h2>${esc(foodName(entry.lm))}</h2>
    <div class="grid2">
      <div class="field"><label for="g">Menge (g)</label><input id="g" inputmode="decimal" value="${esc(String(entry.g).replace(".",","))}"></div>
      <div class="field"><label for="m">Mahlzeit</label><select id="m">${MEALS.map(([k,l])=>`<option value="${k}" ${k===entry.m?"selected":""}>${l}</option>`).join("")}</select></div>
    </div>
    <div class="chips">${f&&f.portion?`<button data-g="${f.portion}">1 Portion (${r0(f.portion)} g)</button>`:""}<button data-d="-10">−10</button><button data-d="10">+10</button><button data-d="50">+50</button><button data-d="100">+100</button></div>
    <div class="field"><label for="n">Notiz (optional)</label><input id="n" value="${esc(entry.notiz||"")}"></div>
    <div class="preview num" id="pv"></div>
    <div class="btnrow"><button class="primary" id="ok">${id?"Speichern":"Eintragen"}</button>${id?'<button class="danger" id="del">Löschen</button>':""}<button class="ghost" id="cancel">Abbrechen</button></div>`,sh=>{
    const g=sh.querySelector("#g"),pv=sh.querySelector("#pv");
    const upd=()=>{const x=num(g.value);if(!(x>0)){pv.textContent="Bitte eine Menge in Gramm eingeben.";return}const n=nut(entry.lm,x);pv.textContent=`${r0(n.kcal)} kcal · Protein ${r1(n.p)} g · KH ${r1(n.kh)} g · Fett ${r1(n.f)} g · Ballaststoffe ${r1(n.bst)} g`};
    upd();g.addEventListener("input",upd);
    if(!id){g.focus();g.select()}
    sh.querySelector(".chips").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;g.value=b.dataset.g?b.dataset.g:String(Math.max(0,(num(g.value)||0)+Number(b.dataset.d)));upd()});
    sh.querySelector("#cancel").onclick=closeSheet;
    sh.querySelector("#ok").onclick=async()=>{
      const x=num(g.value);if(!(x>0)){upd();return}
      const m=sh.querySelector("#m").value,notiz=sh.querySelector("#n").value.trim();
      const path=P.log(S.date);const fl=await file(path);
      const base=id?{...fl.recs[id]}:{d:S.date,t:nowHM()};
      delete base.notiz;delete base.u;
      await putRec(path,id||uid(),{...base,m,lm:entry.lm,g:Math.round(x*10)/10,...(notiz?{notiz}:{})});
      if(!id){const fr=food(entry.lm);if(fr)await putRec(P.lm,entry.lm,{...fr,benutzt:Date.now()})}
      closeSheet();
    };
    const del=sh.querySelector("#del");
    if(del)del.onclick=async()=>{
      if(!del.dataset.armed){del.dataset.armed="1";del.textContent="Wirklich löschen?";return}
      const path=P.log(S.date);const fl=await file(path);await putRec(path,id,{...fl.recs[id],del:true});closeSheet();
    };
  });
}

/* ---------- Open Food Facts + Barcode ---------- */
function offToFood(p){
  const n=p.nutriments||{};
  const kcal=n["energy-kcal_100g"]??(n["energy_100g"]!=null?n["energy_100g"]/4.184:undefined);
  if(kcal==null)return null;
  const name=p.product_name_de||p.product_name||p.generic_name||("Produkt "+p.code);
  const rec={name:name.trim(),marke:(Array.isArray(p.brands)?p.brands.join(","):String(p.brands||"")).split(",")[0].trim(),kcal:Math.round(kcal*10)/10,p:+(n.proteins_100g||0),kh:+(n.carbohydrates_100g||0),f:+(n.fat_100g||0),bst:+(n.fiber_100g||0),zucker:+(n.sugars_100g||0),salz:+(n.salt_100g||0),code:String(p.code||""),quelle:"Open Food Facts"};
  if(p.serving_quantity&&+p.serving_quantity>0)rec.portion=+p.serving_quantity;
  return rec;
}
async function adoptOff(p){
  const rec=offToFood(p);if(!rec)return null;
  const existing=live(foods()).find(([,f])=>f.code&&f.code===rec.code);
  if(existing)return existing[0];
  const id="ean-"+(rec.code||uid());
  await putRec(P.lm,id,rec);return id;
}
async function offByCode(code){
  const r=await fetch(OFF+"/api/v2/product/"+encodeURIComponent(code)+".json?fields="+OFF_FIELDS);
  if(!r.ok)return null;const j=await r.json();return j.status===1?j.product:null;
}
const offCache=new Map();let offLast=0;
const STOP=new Set(["mit","und","ohne","von","der","die","das","im","in","aus","tk","bio","de","la","le","au","a"]);
function offJsonp(q){
  // JSONP über ein <script>-Tag: braucht keine CORS-Header, daher keine "Failed to fetch"-Sperre im Browser
  return new Promise((ok,no)=>{
    const cb="offcb"+Date.now()+Math.floor(Math.random()*1e4),s=document.createElement("script");
    const done=()=>{delete window[cb];s.remove();clearTimeout(t)};
    const t=setTimeout(()=>{done();no(new Error("Zeitüberschreitung"))},15000);
    window[cb]=j=>{done();ok(j.products||[])};
    s.onerror=()=>{done();no(new Error("Failed to fetch"))};
    s.src="https://world.openfoodfacts.org/cgi/search.pl?search_simple=1&action=process&json=1&page_size=40&lc=de&fields="+OFF_FIELDS+"&search_terms="+encodeURIComponent(q)+"&callback="+cb;
    document.head.appendChild(s);
  });
}
async function offQuery(q){
  const key=norm(q);if(offCache.has(key))return offCache.get(key);
  const wait=offLast+3000-Date.now();if(wait>0)await new Promise(r=>setTimeout(r,wait));
  offLast=Date.now();let res;
  try{res=await offJsonp(q)}
  catch(e){
    const r=await fetch("https://search.openfoodfacts.org/search?page_size=50&langs=de,en&fields="+OFF_FIELDS+"&q="+encodeURIComponent(q));
    if(!r.ok)throw new Error("Status "+r.status);
    const j=await r.json();res=(j.hits||j.products||[]).map(h=>h._source||h);
  }
  offCache.set(key,res);return res;
}
async function offSearch(t,onStatus){
  const words=norm(t).split(/[^a-z0-9äöüß]+/).filter(w=>w.length>1&&!STOP.has(w));
  if(!words.length)words.push(norm(t));
  const tries=[words.join(" ")];
  const longest=[...words].sort((a,b)=>b.length-a.length)[0];
  if(words.length>1)tries.push(longest);
  tries.push(longest);  // letzter Versuch nach Pause
  let last="";
  for(let i=0;i<tries.length;i++){
    try{
      const res=await offQuery(tries[i]);
      if(tries[i]===words.join(" "))return res;
      // nur mit dem Hauptwort gesucht: lokal nach den übrigen Wörtern sortieren
      const score=p=>{const h=norm((p.product_name_de||p.product_name||"")+" "+(p.generic_name||"")+" "+[].concat(p.brands||[]).join(" "));return words.filter(w=>h.includes(w)).length};
      return res.map(p=>[score(p),p]).sort((a,b)=>b[0]-a[0]).map(x=>x[1]);
    }catch(e){last=e.message;if(onStatus)onStatus("Versuche es anders … ("+(i+1)+"/"+tries.length+")");if(i===tries.length-2)await new Promise(r=>setTimeout(r,8000))}
  }
  throw new Error(last==="Failed to fetch"?"Suche abgelehnt, vermutlich zu viele Anfragen":last);
}
function offSheet(query,onPick){
  openSheet(`<h2>Open Food Facts</h2>
    <div class="btnrow"><input class="search" id="oq" type="search" placeholder="Produkt oder Marke" value="${esc(query||"")}" style="flex:1;min-width:0"><button class="primary" id="go" style="flex:0 0 auto">Suchen</button></div>
    <div class="hint" id="oh">Sucht in der freien Datenbank Open Food Facts. Gefundene Produkte landen in deinen Lebensmitteln.</div>
    <div class="list" id="ores" hidden></div>
    <button class="ghost" id="cancel">Zurück</button>`,sh=>{
    const q=sh.querySelector("#oq"),res=sh.querySelector("#ores"),h=sh.querySelector("#oh");let found=[];
    const go=async()=>{
      const t=q.value.trim();if(!t)return;
      h.textContent="Suche … (kann bis zu 15 Sekunden dauern)";res.hidden=true;
      try{
        if(/^\d{8,14}$/.test(t)){const p=await offByCode(t);found=p?[p]:[]}
        else found=await offSearch(t,m=>{h.textContent=m});
        found=found.filter(p=>offToFood(p));
        h.textContent=found.length?found.length+" Treffer (Werte pro 100 g):":"Nichts gefunden. Du kannst das Produkt unter „Produkte“ von Hand anlegen.";
        res.innerHTML=found.map((p,i)=>{const f=offToFood(p);return `<button class="row" data-i="${i}"><span class="n">${esc(f.name)}</span><span class="num">${r0(f.kcal)} kcal</span><span class="m">${esc(f.marke)}${p.quantity?" · "+esc(p.quantity):""} · P ${r1(f.p)} · KH ${r1(f.kh)} · F ${r1(f.f)}</span></button>`}).join("");
        res.hidden=!found.length;
      }catch(e){h.textContent="Open Food Facts antwortet gerade nicht ("+e.message+"). Warte eine Minute und such nochmal. Barcode-Scan ist davon weniger betroffen."}
    };
    sh.querySelector("#go").onclick=go;q.addEventListener("keydown",e=>{if(e.key==="Enter")go()});
    res.addEventListener("click",async e=>{const b=e.target.closest("[data-i]");if(!b)return;const id=await adoptOff(found[+b.dataset.i]);if(id)onPick(id)});
    sh.querySelector("#cancel").onclick=closeSheet;
    if(q.value.trim())go();
  });
}
function scanSheet(onPick){
  const can="BarcodeDetector" in window&&navigator.mediaDevices&&navigator.mediaDevices.getUserMedia;
  openSheet(`<h2>Barcode scannen</h2>
    ${can?'<video class="scan" id="vid" playsinline muted></video>':""}
    <div class="hint" id="sh">${can?"Halte den Barcode ruhig vor die Kamera.":"Dieser Browser kann keine Barcodes lesen. Tipp die Zahl unter dem Strichcode ein."}</div>
    <div class="btnrow"><input class="search" id="ean" inputmode="numeric" placeholder="EAN von Hand, z. B. 7610200337214" style="flex:1;min-width:0"><button class="primary" id="go" style="flex:0 0 auto">Suchen</button></div>
    <button class="ghost" id="cancel">Abbrechen</button>`,async sh=>{
    const hint=sh.querySelector("#sh");let stream=null,stop=false;
    sheetCleanup=()=>{stop=true;if(stream)stream.getTracks().forEach(t=>t.stop())};
    const lookup=async code=>{
      hint.textContent="Suche "+code+" …";
      const own=live(foods()).find(([,f])=>f.code===code);
      if(own){sheetCleanup();onPick(own[0]);return}
      try{const p=await offByCode(code);
        if(p&&offToFood(p)){const id=await adoptOff(p);sheetCleanup();onPick(id);return}
        hint.textContent="Produkt "+code+" ist nicht in Open Food Facts. Leg es unter „Produkte“ mit den Werten von der Packung an.";
        sheetCleanup();setTimeout(()=>foodSheet(null,{code}),900);
      }catch(e){hint.textContent="Keine Verbindung zu Open Food Facts. Versuch es online nochmal."}
    };
    sh.querySelector("#go").onclick=()=>{const c=sh.querySelector("#ean").value.replace(/\D/g,"");if(c.length>=8)lookup(c)};
    sh.querySelector("#cancel").onclick=closeSheet;
    if(!can)return;
    try{
      stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"},audio:false});
      const v=sh.querySelector("#vid");v.srcObject=stream;await v.play();
      const det=new BarcodeDetector({formats:["ean_13","ean_8","upc_a","upc_e"]});
      while(!stop){
        const codes=await det.detect(v).catch(()=>[]);
        if(codes.length){stop=true;if(navigator.vibrate)navigator.vibrate(60);lookup(codes[0].rawValue);break}
        await new Promise(r=>setTimeout(r,180));
      }
    }catch(e){hint.textContent="Kamera nicht verfügbar ("+(e.name||e.message)+"). Erlaube den Kamerazugriff oder tipp die Zahl ein."}
  });
}

/* ---------- Rezepte ---------- */
function recipes(){return F[P.rz]?F[P.rz].recs:{}}
function recipe(id){const r=recipes()[id];return r&&!r.del?r:null}
function rzList(){return live(recipes()).map(([id,r])=>({id,...r})).sort((a,b)=>(a.kat||"").localeCompare(b.kat||"")||a.name.localeCompare(b.name,"de"))}
function rzRows(list,attr){
  if(!list.length)return '<div class="leer" style="padding:12px 14px">Noch keine Rezepte.</div>';
  return list.map(r=>{const s=sum(r.zutaten||[]);return `<button class="row" ${attr}="${esc(r.id)}"><span class="n">${esc(r.name)}${r.kat?`<span class="tag">${esc(r.kat)}</span>`:""}</span><span class="num">${r0(s.kcal)} kcal</span><span class="m num">pro Portion · P ${r0(s.p)} · KH ${r0(s.kh)} · F ${r0(s.f)} · ${(r.zutaten||[]).length} Zutaten</span></button>`}).join("");
}
function renderRz(){
  const v=$("#v-rz");
  if(!v.querySelector("#rzlist")){
    v.innerHTML=`<div class="btnrow"><input class="search" id="rzq" type="search" placeholder="Rezept suchen" style="flex:1;min-width:0"><button class="primary" id="rzneu" style="flex:0 0 auto">Neu</button></div>
      <div class="hint">Mengen pro Portion. Tippe ein Rezept an, um es anzusehen, zu ändern oder einzutragen.</div>
      <div class="list" id="rzlist"></div>`;
    v.querySelector("#rzq").addEventListener("input",drawRz);
    v.querySelector("#rzneu").onclick=()=>recipeSheet(null);
    v.querySelector("#rzlist").addEventListener("click",e=>{const b=e.target.closest("[data-rz]");if(b)recipeSheet(b.dataset.rz)});
  }
  drawRz();
}
function drawRz(){const l=$("#rzlist");if(!l)return;const ws=norm($("#rzq").value).split(/\s+/).filter(Boolean);l.innerHTML=rzRows(rzList().filter(r=>ws.every(w=>norm(r.name+" "+(r.kat||"")).includes(w))),"data-rz")}
function pickRecipe(onPick,meal){
  const pref={frueh:"Frühstück",snack:"Snack"}[meal]||"Hauptgericht";
  const all=rzList().sort((a,b)=>((b.kat===pref)-(a.kat===pref))||a.name.localeCompare(b.name,"de"));
  openSheet(`<h2>Rezept wählen</h2><input class="search" id="rq" type="search" placeholder="Rezept suchen" autocomplete="off"><div class="list" id="pr" style="max-height:55vh;overflow-y:auto;overscroll-behavior:contain"></div><button class="ghost" id="cancel">Abbrechen</button>`,sh=>{
    const pr=sh.querySelector("#pr"),q=sh.querySelector("#rq");
    const draw=()=>{const ws=norm(q.value).split(/\s+/).filter(Boolean);pr.innerHTML=rzRows(all.filter(r=>ws.every(w=>norm(r.name+" "+(r.kat||"")).includes(w))),"data-pr")};
    draw();q.addEventListener("input",draw);
    pr.addEventListener("click",e=>{const b=e.target.closest("[data-pr]");if(b)onPick(b.dataset.pr)});
    sh.querySelector("#cancel").onclick=closeSheet;
  });
}
function remainingFor(meal){
  // Tagesziel minus bereits Eingetragenes minus geplante Mahlzeiten, die noch offen sind (ohne die gewählte)
  const plan=dayPlan(S.date);if(!plan||!plan.ziele)return null;
  const z=plan.ziele,ist=sum(dayLog(S.date));const keys=MEALS.map(m=>m[0]);
  const logged=new Set(dayLog(S.date).map(e=>keys.includes(e.m)?e.m:"extra"));
  const res=zero();const open=[];
  for(const pm of plan.mahlzeiten||[]){if(pm.key===meal||logged.has(pm.key))continue;open.push(MEALNAME[pm.key]);add(res,sum(pm.items||[]))}
  const t={};for(const k of ["kcal","p","kh","f"])t[k]=Math.max(0,(z[k]||0)-ist[k]-res[k]);
  return {t,open};
}
function zero(){return {kcal:0,p:0,kh:0,f:0,bst:0}}
function add(a,b){for(const k in a)a[k]+=b[k]||0;return a}
function fitAmounts(items,t){
  // Faktoren pro Zutat (0,25–3× Rezeptmenge) so wählen, dass kcal/P/KH/F möglichst genau den Zielwerten entsprechen
  const K=["kcal","p","kh","f"],W={kcal:1,p:1.5,kh:1,f:1};
  const N=items.map(z=>{const f=food(z.lm)||{};return K.map(k=>(Number(f[k])||0)*z.g/100)});
  let x=items.map(()=>1);const T=K.map(k=>Math.max(t[k],1));
  for(let it=0;it<4000;it++){
    const s=K.map((_,j)=>N.reduce((a,n,i)=>a+n[j]*x[i],0));
    const mean=x.reduce((a,b)=>a+b,0)/x.length;
    x=x.map((xi,i)=>{let g=0;K.forEach((k,j)=>{g+=2*W[k]*(s[j]-T[j])/(T[j]*T[j])*N[i][j]});g+=0.02*(xi-mean);return Math.min(3,Math.max(0.25,xi-0.02*g))});
  }
  return items.map((z,i)=>({lm:z.lm,g:Math.round(z.g*x[i]/5)*5||Math.round(z.g*x[i])}));
}
function cookSheet(rid,meal){
  const r=recipe(rid);if(!r)return;
  let items=(r.zutaten||[]).map(z=>({...z}));
  openSheet(`<h2>${esc(r.name)} eintragen</h2>
    <div class="field"><label for="m">Mahlzeit</label><select id="m">${MEALS.map(([k,l])=>`<option value="${k}" ${k===meal?"selected":""}>${l}</option>`).join("")}</select></div>
    <div class="chips"><button data-f="0.5">½ Portion</button><button data-f="1">1</button><button data-f="1.5">1½</button><button data-f="2">2</button><button data-fit="1" style="border-color:var(--accent);color:var(--accent);font-weight:600">Passend zum Rest des Tages</button></div>
    <div class="hint" id="fh" hidden></div>
    <div id="zl"></div>
    <div class="preview num" id="pv"></div>
    <div class="btnrow"><button class="primary" id="ok">Eintragen</button><button class="ghost" id="cancel">Abbrechen</button></div>`,sh=>{
    const zl=sh.querySelector("#zl"),pv=sh.querySelector("#pv"),fh=sh.querySelector("#fh");
    let target=null;
    const sumUp=()=>{const s=sum(items);pv.textContent=`${r0(s.kcal)} kcal · Protein ${r1(s.p)} g · KH ${r1(s.kh)} g · Fett ${r1(s.f)} g`+(target?`\nZiel: ${r0(target.kcal)} kcal · P ${r0(target.p)} · KH ${r0(target.kh)} · F ${r0(target.f)}`:"");pv.style.whiteSpace="pre-line"};
    const draw=()=>{zl.innerHTML=items.map((z,i)=>`<div class="zrow" style="grid-template-columns:minmax(0,1fr) 90px"><span class="n">${esc(foodName(z.lm))}</span><input inputmode="decimal" data-zi="${i}" value="${String(z.g).replace(".",",")}" aria-label="Gramm"></div>`).join("");sumUp()};
    draw();
    zl.addEventListener("input",e=>{const i=e.target.dataset.zi;if(i==null)return;const x=num(e.target.value);if(x>=0){items[i].g=x;sumUp()}});
    sh.querySelector(".chips").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;
      if(b.dataset.fit){const rem=remainingFor(sh.querySelector("#m").value);fh.hidden=false;
        if(!rem){fh.textContent="Für heute gibt es keinen Plan mit Zielen.";return}
        target=rem.t;items=fitAmounts(r.zutaten||[],rem.t);
        fh.textContent=(rem.t.kcal<150?"Achtung: Dein Tagesziel ist schon fast oder ganz erreicht, deshalb nur Mindestmengen. ":"")+"Berechnet aus Tagesziel minus Eingetragenem"+(rem.open.length?" minus noch geplant: "+rem.open.join(", "):"")+". Mengen kannst du unten noch ändern.";}
      else{target=null;fh.hidden=true;items=(r.zutaten||[]).map(z=>({lm:z.lm,g:Math.round(z.g*Number(b.dataset.f)*10)/10}))}
      draw()});
    sh.querySelector("#cancel").onclick=closeSheet;
    sh.querySelector("#ok").onclick=async()=>{
      const m=sh.querySelector("#m").value;
      const path=P.log(S.date);const f=await file(path);const t=nowHM();
      items.filter(z=>z.g>0).forEach((z,i)=>{f.recs[uid()+i]={d:S.date,m,lm:z.lm,g:Math.round(z.g*10)/10,t,rezept:rid,u:Date.now()}});
      f.dirty=true;await saveFile(path);closeSheet();if(S.tab!=="tag")setTab("tag");else render();scheduleSync(1500);
    };
  });
}
function recipeSheet(id,draft){
  const r0_=draft||(id?recipe(id):{name:"",kat:"",zutaten:[],notiz:""});
  const st={zutaten:(r0_.zutaten||[]).map(z=>({...z}))};
  openSheet(`<h2>${id?"Rezept":"Neues Rezept"}</h2>
    <div class="grid2"><div class="field"><label for="r-name">Name</label><input id="r-name" value="${esc(r0_.name)}"></div>
    <div class="field"><label for="r-kat">Kategorie</label><input id="r-kat" list="katl" value="${esc(r0_.kat||"")}"><datalist id="katl"><option value="Hauptgericht"><option value="Frühstück"><option value="Snack"></datalist></div></div>
    <div class="rtabs"><button type="button" data-rt="z" aria-current="page">Zutaten</button><button type="button" data-rt="n">Zubereitung</button></div>
    <div id="rt-z" style="display:flex;flex-direction:column;gap:12px"><div class="preview num" id="rs"></div>
    <div><span class="lbl">Zutaten pro Portion (g)</span><div id="zl"></div></div>
    <button class="ghost" id="zadd">+ Zutat</button></div>
    <div id="rt-n" hidden><div class="field"><label for="r-notiz">Zubereitung / Notizen</label><textarea id="r-notiz" style="min-height:45vh">${esc(r0_.notiz||"")}</textarea></div></div>
    <div class="fv preview" id="fv" hidden></div>
    <div class="btnrow">${id?'<button class="primary" id="cook">Eintragen</button>':""}<button class="${id?"ghost":"primary"}" id="ok" style="flex:1">Speichern</button>${id?'<button class="danger" id="del">Löschen</button>':""}<button class="ghost" id="cancel">Schließen</button></div>`,sh=>{
    const zl=sh.querySelector("#zl"),rs=sh.querySelector("#rs");
    sh.querySelector(".rtabs").addEventListener("click",e=>{const b=e.target.closest("[data-rt]");if(!b)return;sh.querySelectorAll("[data-rt]").forEach(x=>x.setAttribute("aria-current",x===b?"page":"false"));sh.querySelector("#rt-z").hidden=b.dataset.rt!=="z";sh.querySelector("#rt-n").hidden=b.dataset.rt!=="n"});
    const draw=()=>{
      zl.innerHTML=st.zutaten.map((z,i)=>`<div class="zrow"><span class="n">${esc(foodName(z.lm))}</span><input inputmode="decimal" data-zi="${i}" value="${String(z.g).replace(".",",")}" aria-label="Gramm"><button data-zx="${i}" aria-label="Entfernen">✕</button></div>`).join("")||'<div class="hint">Noch keine Zutaten.</div>';
      const s=sum(st.zutaten);rs.textContent=`pro Portion: ${r0(s.kcal)} kcal · Protein ${r1(s.p)} g · KH ${r1(s.kh)} g · Fett ${r1(s.f)} g · Ballaststoffe ${r1(s.bst)} g`;
    };
    draw();
    zl.addEventListener("input",e=>{const i=e.target.dataset.zi;if(i==null)return;const x=num(e.target.value);if(x>=0){st.zutaten[i].g=x;const s=sum(st.zutaten);rs.textContent=`pro Portion: ${r0(s.kcal)} kcal · Protein ${r1(s.p)} g · KH ${r1(s.kh)} g · Fett ${r1(s.f)} g · Ballaststoffe ${r1(s.bst)} g`}});
    zl.addEventListener("click",e=>{const b=e.target.closest("[data-zx]");if(b){st.zutaten.splice(+b.dataset.zx,1);draw()}});
    const collect=()=>({...(id?recipe(id):{}),name:sh.querySelector("#r-name").value.trim(),kat:sh.querySelector("#r-kat").value.trim(),notiz:sh.querySelector("#r-notiz").value,zutaten:st.zutaten.filter(z=>z.g>0)});
    sh.querySelector("#zadd").onclick=()=>{
      const keep=collect();
      openSheet(`<h2>Zutat hinzufügen</h2><input class="search" id="q" type="search" placeholder="Produkt suchen" autocomplete="off"><div class="btnrow"><button class="ghost" id="zscan" style="flex:1">Barcode</button><button class="ghost" id="zoff" style="flex:1">Open Food Facts</button></div><div class="list" id="res" style="overflow-y:auto;overscroll-behavior:contain;min-height:120px;flex:1 1 auto"></div><button class="ghost" id="back">Zurück</button>`,s2=>{
        const q=s2.querySelector("#q"),res=s2.querySelector("#res");const d2=()=>{res.innerHTML=foodRows(searchFoods(q.value),"data-pick")};d2();q.addEventListener("input",d2);q.focus();
        const back=extra=>recipeSheet(id,{...keep,zutaten:[...keep.zutaten,...(extra?[extra]:[])]});
        res.addEventListener("click",e=>{const b=e.target.closest("[data-pick]");if(b){const f=food(b.dataset.pick);back({lm:b.dataset.pick,g:f.portion||100})}});
        s2.querySelector("#back").onclick=()=>back(null);
        const pickId=id2=>{const f=food(id2);back({lm:id2,g:(f&&f.portion)||100})};
        s2.querySelector("#zscan").onclick=()=>scanSheet(pickId);
        s2.querySelector("#zoff").onclick=()=>offSheet(q.value,pickId);
      });
    };
    const save=async()=>{const out=collect();const fv=sh.querySelector("#fv");if(!out.name){fv.hidden=false;fv.textContent="Bitte einen Namen eingeben.";return false}delete out.u;delete out.id;await putRec(P.rz,id||("rz-"+uid()),out);return id||true};
    sh.querySelector("#ok").onclick=async()=>{if(await save())closeSheet()};
    sh.querySelector("#cancel").onclick=closeSheet;
    const ck=sh.querySelector("#cook");if(ck)ck.onclick=async()=>{if(await save())cookSheet(id,"abend")};
    const del=sh.querySelector("#del");if(del)del.onclick=async()=>{if(!del.dataset.armed){del.dataset.armed="1";del.textContent="Wirklich löschen?";return}await putRec(P.rz,id,{...recipe(id),del:true});closeSheet()};
  });
}
/* ---------- Lebensmittel ---------- */
function renderLm(){
  const v=$("#v-lm");
  if(!v.querySelector("#lmq")){
    v.innerHTML=`<div class="btnrow"><input class="search" id="lmq" type="search" placeholder="Suchen (Name, Marke, EAN)" style="flex:1;min-width:0"><button class="primary" id="neu" style="flex:0 0 auto">Neu</button></div>
      <div class="btnrow"><button class="ghost" id="lscan" style="flex:1">Barcode scannen</button><button class="ghost" id="loff" style="flex:1">Open Food Facts</button></div>
      <div class="hint">Werte pro 100 g. Tippe ein Lebensmittel an, um es zu ändern.</div>
      <div class="list" id="lmlist"></div>`;
    v.querySelector("#lmq").addEventListener("input",e=>{S.lmQuery=e.target.value;drawLm()});
    v.querySelector("#neu").onclick=()=>foodSheet(null);
    v.querySelector("#lscan").onclick=()=>scanSheet(id=>foodSheet(id));
    v.querySelector("#loff").onclick=()=>offSheet(S.lmQuery,id=>foodSheet(id));
    v.querySelector("#lmlist").addEventListener("click",e=>{const b=e.target.closest("[data-food]");if(b)foodSheet(b.dataset.food)});
  }
  drawLm();
}
function drawLm(){const l=$("#lmlist");if(l)l.innerHTML=foodRows(searchFoods(S.lmQuery),"data-food")}
function foodSheet(id,preset){
  const f=id?food(id):{name:"",marke:"",...(preset||{})};
  const fld=(k,l)=>`<div class="field"><label for="f-${k}">${l}</label><input id="f-${k}" inputmode="decimal" value="${f[k]==null?"":esc(String(f[k]).replace(".",","))}"></div>`;
  openSheet(`<h2>${id?"Lebensmittel ändern":"Neues Lebensmittel"}</h2>
    <div class="field"><label for="f-name">Name</label><input id="f-name" value="${esc(f.name)}"></div>
    <div class="grid2"><div class="field"><label for="f-marke">Marke / Laden</label><input id="f-marke" value="${esc(f.marke||"")}"></div>
    <div class="field"><label for="f-code">EAN (optional)</label><input id="f-code" inputmode="numeric" value="${esc(f.code||"")}"></div></div>
    <div class="hint">Nährwerte pro 100 g</div>
    <div class="grid3">${fld("kcal","kcal")}${fld("p","Protein g")}${fld("kh","KH g")}${fld("f","Fett g")}${fld("bst","Ballast g")}${fld("zucker","Zucker g")}</div>
    <div class="field"><label for="f-portion">Portion in g (optional, z. B. 1 Brötchen)</label><input id="f-portion" inputmode="decimal" value="${f.portion?esc(String(f.portion)):""}"></div>
    ${f.quelle?`<div class="hint">Quelle: ${esc(f.quelle)}</div>`:""}
    <div class="preview" id="fv" hidden></div>
    <div class="btnrow"><button class="primary" id="ok">Speichern</button>${id?'<button class="danger" id="del">Löschen</button>':""}<button class="ghost" id="cancel">Abbrechen</button></div>`,sh=>{
    sh.querySelector("#cancel").onclick=closeSheet;
    sh.querySelector("#ok").onclick=async()=>{
      const val=k=>sh.querySelector("#f-"+k).value.trim();
      const out={...(id?food(id):{}),name:val("name"),marke:val("marke"),code:val("code").replace(/\D/g,"")};
      for(const k of ["kcal","p","kh","f","bst","zucker","portion"]){const x=num(val(k));if(!isNaN(x))out[k]=x;else delete out[k]}
      if(!out.code)delete out.code;
      const fv=sh.querySelector("#fv");
      if(!out.name||!(out.kcal>=0)||isNaN(out.p)||isNaN(out.kh)||isNaN(out.f)){fv.hidden=false;fv.textContent="Name, kcal, Protein, KH und Fett braucht es mindestens.";return}
      if(!id)out.quelle=out.quelle||"von Hand";
      delete out.u;
      await putRec(P.lm,id||("lm-"+uid()),out);closeSheet();
    };
    const del=sh.querySelector("#del");
    if(del)del.onclick=async()=>{if(!del.dataset.armed){del.dataset.armed="1";del.textContent="Wirklich löschen?";return}await putRec(P.lm,id,{...food(id),del:true});closeSheet()};
  });
}

/* ---------- Gewicht ---------- */
function renderKg(){
  const v=$("#v-kg");
  const ws=live(F[P.kg]&&F[P.kg].recs).map(([d,r])=>({d,kg:Number(r.kg)})).sort((a,b)=>a.d<b.d?-1:1);
  const last=ws.slice(-60);
  let spark="";
  if(last.length>=2){
    const W=320,H=110,pad=30;const xs=last.map(w=>new Date(w.d+"T12:00:00").getTime());const ys=last.map(w=>w.kg);
    const x0=Math.min(...xs),x1=Math.max(...xs),lo=Math.min(...ys),hi=Math.max(...ys),y0=lo-0.3,y1=hi+0.3;
    const X=t=>pad+(x1===x0?0:(t-x0)/(x1-x0)*(W-pad-8)),Y=k=>8+(y1-k)/(y1-y0)*(H-26);
    const pts=last.map((w,i)=>X(xs[i]).toFixed(1)+","+Y(w.kg).toFixed(1)).join(" ");
    spark=`<div class="card spark"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gewichtsverlauf">
      <line x1="${pad}" x2="${W-8}" y1="${Y(hi).toFixed(1)}" y2="${Y(hi).toFixed(1)}" stroke="var(--line)"/>
      <line x1="${pad}" x2="${W-8}" y1="${Y(lo).toFixed(1)}" y2="${Y(lo).toFixed(1)}" stroke="var(--line)"/>
      <text x="0" y="${(Y(hi)+4).toFixed(1)}" font-size="10" fill="var(--muted)">${r1(hi)}</text>
      <text x="0" y="${(Y(lo)+4).toFixed(1)}" font-size="10" fill="var(--muted)">${r1(lo)}</text>
      <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="${X(xs[xs.length-1]).toFixed(1)}" cy="${Y(ys[ys.length-1]).toFixed(1)}" r="4" fill="var(--accent)"/>
      <text x="${W-8}" y="${H-3}" text-anchor="end" font-size="10" fill="var(--muted)">letzte ${last.length} Messungen</text></svg></div>`;
  }
  const avg=(from,to)=>{const s=ws.filter(w=>w.d>from&&w.d<=to);return s.length?s.reduce((a,w)=>a+w.kg,0)/s.length:null};
  const t=today(),a1=avg(addDays(t,-7),t),a0=avg(addDays(t,-14),addDays(t,-7));
  const keepDate=v.querySelector("#kgd")?v.querySelector("#kgd").value:t;
  v.innerHTML=`<form class="card form" id="kgf">
      <div class="field" style="flex:1 1 140px"><label for="kgd">Datum</label><input id="kgd" type="date" value="${keepDate}"></div>
      <div class="field" style="flex:1 1 110px"><label for="kgv">Gewicht (kg)</label><input id="kgv" inputmode="decimal" placeholder="84,5"></div>
      <button class="primary" type="submit">Speichern</button></form>
    <div class="card konto"><div class="makros" style="grid-template-columns:repeat(2,minmax(0,1fr))">
      <div class="makro"><span class="lbl">Schnitt 7 Tage</span><span class="num" style="font-size:20px">${a1?r1(a1)+" kg":"–"}</span></div>
      <div class="makro"><span class="lbl">Woche davor</span><span class="num" style="font-size:20px">${a0?r1(a0)+" kg":"–"}</span>${a1&&a0?`<span class="num hint">${a1-a0>=0?"+":""}${r1(a1-a0)} kg</span>`:""}</div>
    </div></div>
    ${spark}
    <h3 class="sec">Messungen</h3>
    <div class="list">${ws.length?ws.slice().reverse().slice(0,60).map(w=>`<button class="row" data-w="${w.d}"><span class="n">${new Date(w.d+"T12:00:00").toLocaleDateString("de-CH",{weekday:"short",day:"numeric",month:"numeric",year:"2-digit"})}</span><span class="num">${r1(w.kg)} kg</span></button>`).join(""):'<div class="leer" style="padding:12px 14px">Noch keine Messung.</div>'}</div>`;
  v.querySelector("#kgf").addEventListener("submit",async e=>{
    e.preventDefault();const d=v.querySelector("#kgd").value,kg=num(v.querySelector("#kgv").value);
    if(!d||!(kg>30&&kg<250))return;
    await putRec(P.kg,d,{kg:Math.round(kg*10)/10});
  });
  v.querySelector(".list").addEventListener("click",e=>{const b=e.target.closest("[data-w]");if(!b)return;const d=b.dataset.w;const w=F[P.kg].recs[d];
    openSheet(`<h2>Messung ${esc(d)}</h2><div class="field"><label for="ekg">Gewicht (kg)</label><input id="ekg" inputmode="decimal" value="${String(w.kg).replace(".",",")}"></div>
      <div class="btnrow"><button class="primary" id="ok">Speichern</button><button class="danger" id="del">Löschen</button><button class="ghost" id="cancel">Abbrechen</button></div>`,sh=>{
      sh.querySelector("#cancel").onclick=closeSheet;
      sh.querySelector("#ok").onclick=async()=>{const kg=num(sh.querySelector("#ekg").value);if(!(kg>30&&kg<250))return;await putRec(P.kg,d,{kg:Math.round(kg*10)/10});closeSheet()};
      const del=sh.querySelector("#del");del.onclick=async()=>{if(!del.dataset.armed){del.dataset.armed="1";del.textContent="Wirklich löschen?";return}await putRec(P.kg,d,{kg:w.kg,del:true});closeSheet()};
    })});
}

/* ---------- Sync-Einstellungen ---------- */
function renderSync(){
  const v=$("#v-sync");
  const pending=Object.entries(F).filter(([,f])=>f.dirty).map(([p])=>p);
  v.innerHTML=`<div class="card konto">
      <div><span class="lbl">Status</span><div>${esc($("#sync span").textContent)}</div></div>
      ${pending.length?`<div class="hint">Noch nicht abgeglichen: ${pending.map(esc).join(", ")}</div>`:""}
      <div class="btnrow"><button class="primary" id="now">Jetzt abgleichen</button></div>
    </div>
    <form class="card konto" id="cf">
      <div class="field"><label for="repo">Daten-Repo</label><input id="repo" value="${esc(S.cfg.repo)}" autocapitalize="off" spellcheck="false"></div>
      <div class="field"><label for="tok">GitHub-Zugangsschlüssel</label><input id="tok" type="password" placeholder="${S.cfg.token?"gespeichert, zum Ändern neu einfügen":"github_pat_…"}" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="btnrow"><button class="primary" type="submit">Speichern</button>${S.cfg.token?'<button class="ghost" type="button" id="forget">Schlüssel entfernen</button>':""}</div>
      <div class="hint">Der Schlüssel bleibt nur auf diesem Gerät. App-Version ${VERSION}.</div>
    </form>
    <div class="card konto"><h3 class="sec">Schlüssel erstellen (einmalig)</h3>
      <ol class="steps">
        <li>Öffne <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com → Fine-grained token</a>.</li>
        <li>Name: <code>Futterbuch Handy</code>, Ablauf: so lang wie möglich.</li>
        <li>Repository access: <b>Only select repositories</b> → <code>futterbuch-_daten</code>.</li>
        <li>Permissions → Repository → <b>Contents: Read and write</b>.</li>
        <li>Erstellen, Schlüssel kopieren und oben einfügen.</li>
      </ol></div>`;
  v.querySelector("#now").onclick=()=>syncAll();
  v.querySelector("#cf").addEventListener("submit",async e=>{
    e.preventDefault();const t=v.querySelector("#tok").value.trim();
    S.cfg.repo=v.querySelector("#repo").value.trim()||DEF_REPO;if(t)S.cfg.token=t;
    await kv.set("cfg",S.cfg);syncAll();renderSync();
  });
  const fg=v.querySelector("#forget");if(fg)fg.onclick=async()=>{S.cfg.token="";await kv.set("cfg",S.cfg);setSync("local");renderSync()};
}

/* ---------- Navigation ---------- */
function render(){
  for(const t of ["tag","rz","lm","kg","sync"]){$("#v-"+t).hidden=S.tab!==t;$("#t-"+t).setAttribute("aria-current",S.tab===t?"page":"false")}
  for(const id of ["#prev","#next","#heute"])$(id).hidden=S.tab!=="tag";
  if(S.tab==="tag")renderTag();
  else{
    $("#titel").firstChild.nodeValue={rz:"Rezepte",lm:"Produkte",kg:"Gewicht",sync:"Abgleich"}[S.tab];
    $("#untertitel").textContent=S.tab==="rz"?live(recipes()).length+" Rezepte":S.tab==="lm"?live(foods()).length+" Einträge":S.tab==="kg"?"":"GitHub";
    if(S.tab==="rz")renderRz();else if(S.tab==="lm")renderLm();else if(S.tab==="kg")renderKg();else renderSync();
  }
}
function setTab(t){S.tab=t;render();window.scrollTo(0,0)}
for(const t of ["tag","rz","lm","kg","sync"])$("#t-"+t).onclick=()=>setTab(t);
async function goDate(d){S.date=d;await file(P.plan(d));await file(P.log(d));render();if(S.cfg.token&&(!F[P.plan(d)].sha||!F[P.log(d)].sha))scheduleSync(200)}
$("#prev").onclick=()=>goDate(addDays(S.date,-1));
$("#next").onclick=()=>goDate(addDays(S.date,1));
$("#heute").onclick=()=>goDate(today());
$("#v-tag").addEventListener("click",e=>{
  const a=e.target.closest("[data-add]"),ed=e.target.closest("[data-edit]"),pl=e.target.closest("[data-plan]");
  if(a)addFlow(a.dataset.add);
  else if(ed){const en=dayLog(S.date).find(x=>x.id===ed.dataset.edit);if(en)amountSheet(en,en.id)}
  else if(pl){pl.disabled=true;planToLog(pl.dataset.plan)}
});
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeSheet()});
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"){if(S.date!==today()&&S._lastToday!==today()){S._lastToday=today()}syncAll()}});
window.addEventListener("online",()=>syncAll());
setInterval(()=>{if(document.visibilityState==="visible")syncAll()},120000);

(async function start(){
  try{
    const cfg=await kv.get("cfg");if(cfg)S.cfg={...S.cfg,...cfg};
    for(const k of (await kv.keys())||[]){if(String(k).startsWith("f:"))await file(String(k).slice(2))}
    await file(P.lm);await file(P.kg);await file(P.rz);await goDate(S.date);
  }catch(e){$("#sync span").textContent="Lokaler Speicher nicht verfügbar: "+e.message}
  setSync(S.cfg.token?"busy":"local");
  syncAll();
  if("serviceWorker" in navigator)navigator.serviceWorker.register("sw.js").catch(()=>{});
})();
