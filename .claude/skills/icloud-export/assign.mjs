#!/usr/bin/env node
// Put undated photographs on the right days, by hand, in the order the camera
// took them.
//
//   node assign.mjs --trip second-trip-2023 --into example-trip-2024 [--user alex]
//
// `--trip` is the exported folder of undated photographs; `--into` is the trip
// in content/ whose days they belong to. The days offered are that trip's real
// days — this never invents one.
//
// Why a page and not a prompt: the only person who knows which morning a
// photograph belongs to is the person who was there, and the fastest way to
// say it is to see the pictures in order and drag a boundary. Filename order
// is the timeline, so a run of consecutive frames is almost always one day:
// click the first, shift-click the last, press a day.
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { createReadStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, arg, die, stemOf } from "../shared/lib.mjs";
import { ensureBaked } from "./bake.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const trip = arg("trip") ?? die("--trip <exported folder of undated photographs> is required.");
const into = arg("into") ?? die("--into <trip in content/> is required — whose days these belong to.");
const user = arg("user") ?? die("--user <name> is required — the folder your journal lives in.");
const PORT = Number(arg("port") ?? 4400);

const DIR = join(ROOT, "export", trip);
const PHOTOS = join(DIR, "photos"), THUMBS = join(DIR, "thumbs"), STATE = join(DIR, "assign.json");
if (!existsSync(PHOTOS)) die(`Nothing exported yet. Run export.mjs --trip ${trip} first.`);

const TRIPDIR = join(ROOT, "content", user, "trips", into);
if (!existsSync(TRIPDIR)) die(`No trip at content/${user}/trips/${into}.`);

// The days on offer are the trip's own, read from the folder. A photograph can
// only join a day that exists; making one is a different decision, made
// elsewhere, by someone who knows what happened on it.
const DAYS = readdirSync(join(TRIPDIR, "entries")).filter((f) => f.endsWith(".json")).map((f) => {
  const j = JSON.parse(readFileSync(join(TRIPDIR, "entries", f), "utf8"));
  return { slug: f.replace(/\.json$/, ""), date: j.date, title: j.title || j.date,
           location: j.location || "", country: j.country || "",
           have: (j.media || []).length };
}).sort((a, b) => a.date.localeCompare(b.date));

const meta = new Map();
for (const p of JSON.parse(readFileSync(join(DIR, "photos.json"), "utf8")).photos) meta.set(stemOf(p.name), p);

const files = readdirSync(PHOTOS).filter((f) => /\.jpe?g$/i.test(f))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));      // the camera's own order
if (!files.length) die("No photographs in that folder.");

console.log(`preparing ${files.length} photographs…`);
const baked = new Map(files.map((f) => [f, ensureBaked(DIR, PHOTOS, f)]));
let thumbed = [];
try { thumbed = readdirSync(THUMBS) } catch {}
if (thumbed.filter((f) => /\.jpe?g$/i.test(f)).length !== files.length) {
  console.log(`  making ${files.length} thumbnails…`);
  execFileSync("mkdir", ["-p", THUMBS]);
  execFileSync("sips", ["-Z", "500", "-s", "formatOptions", "65",
    ...files.map((f) => baked.get(f)), "--out", THUMBS], { stdio: "ignore" });
}

const HTML = String.raw`<!doctype html><meta charset="utf-8"><meta name=viewport content="width=device-width,initial-scale=1">
<title>Fernscout · put the photographs on their days</title>
<style>
 :root{color-scheme:light;
   --cream-50:#fffaf0;--cream-100:#fff3dc;--cream-200:#ffe9bd;
   --navy-900:#1e293b;--navy-600:#44546c;--navy-200:#d8dee8;
   --yellow-400:#ffd23f;--green-700:#15803d;--coral-600:#c2334a;--blue-500:#2f6fed;--line:var(--navy-200)}
 *{box-sizing:border-box}
 body{font:17px/1.6 system-ui,-apple-system,sans-serif;margin:0;background:var(--cream-50);color:var(--navy-900)}
 .wrap{display:grid;grid-template-columns:minmax(0,1fr) 22rem;gap:1.5rem;align-items:start;padding:0 1.5rem 4rem}
 @media (max-width:1100px){.wrap{grid-template-columns:1fr}#side{position:static;max-height:none}}
 main{min-width:0}
 header{padding:1.5rem 0 .5rem}
 header img{height:44px;width:auto;display:block;margin-bottom:1rem}
 h1{font-size:1.6rem;margin:0 0 .5rem}
 .lede{margin:0 0 .5rem;max-width:52rem;color:var(--navy-600)}
 .lede b{color:var(--navy-900)}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:1rem}
 figure{margin:0;position:relative;content-visibility:auto;contain-intrinsic-size:auto 250px;cursor:pointer;
        border-radius:10px;outline:3px solid transparent;outline-offset:3px}
 figure.sel{outline-color:var(--blue-500)}
 figure.done{opacity:.55}
 img{width:100%;aspect-ratio:3/2;object-fit:cover;border-radius:8px;display:block;background:var(--line)}
 .cap{display:flex;justify-content:space-between;font-size:.8rem;color:var(--navy-600);padding:.25rem .15rem}
 .tag{position:absolute;top:.4rem;left:.4rem;background:var(--navy-900);color:#fff;font-size:.72rem;
      padding:.15rem .45rem;border-radius:5px;font-weight:600}
 .tag.none{background:var(--coral-600)}
 /* The days sit beside the photographs rather than under them: a vertical
    list reads in date order at a glance, and stays put while the grid scrolls. */
 #side{position:sticky;top:1rem;max-height:calc(100vh - 2rem);overflow:auto;
       background:var(--cream-100);border:1px solid var(--cream-200);border-left:5px solid var(--yellow-400);
       border-radius:10px;padding:.9rem}
 #side h2{margin:0 0 .2rem;font-size:1rem;text-transform:uppercase;letter-spacing:.05em;color:var(--navy-600)}
 #count{display:block;font-size:1.05rem;margin:.1rem 0 .1rem}
 #saved{color:var(--navy-600);font-size:.85rem}
 .days{display:flex;flex-direction:column;gap:.35rem;margin-top:.75rem}
 .days button{font:inherit;font-size:.9rem;text-align:left;padding:.4rem .55rem;border-radius:8px;
      border:2px solid var(--navy-200);background:#fff;color:var(--navy-900);cursor:pointer;line-height:1.3}
 .days button:hover{border-color:var(--blue-500)}
 .days button.has{border-color:var(--green-700);background:#f6fbf7}
 .days .d{font-weight:600}
 .days .w{display:block;font-size:.8rem;color:var(--navy-600)}
 .days .n{float:right;font-weight:600;color:var(--green-700)}
 #clear{border-color:var(--coral-600);color:var(--coral-600);margin-top:.5rem}
 kbd{background:#fff;border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:0 .3rem;font-size:.85em}
</style>
<header>
 <img src="/logo.svg" alt="Fernscout">
 <h1>__TRIP__ → __INTO__</h1>
 <p class=lede>These photographs carry no date the library could trust, so they are shown in
  <b>the order the camera took them</b> — the filename is the timeline.</p>
 <p class=lede>Click a photograph to select it. <kbd>Shift</kbd>-click to select everything in between —
  a run of consecutive frames is usually one day. Then press the day it belongs to, below.</p>
 <p class=lede>Nothing is written to the journal here. This only records which day each one belongs to.</p>
</header>
<div class=wrap>
 <main><div class=grid id=grid></div></main>
 <aside id=side>
  <h2>put on a day</h2>
  <b id=count>nothing selected</b><span id=saved></span>
  <div class=days id=days></div>
 </aside>
</div>
<script type=module>
const $=(t,p={},...c)=>{const e=Object.assign(document.createElement(t),p);c.flat().forEach(x=>e.append(x));return e};
const data=await (await fetch("data")).json();
const state=data.assign||{};
const grid=document.getElementById("grid"), bar=document.getElementById("days");
const count=document.getElementById("count"), saved=document.getElementById("saved");
let sel=new Set(), last=null;

let timer;
const save=()=>{clearTimeout(timer);saved.textContent=" · saving…";
  timer=setTimeout(async()=>{await fetch("save",{method:"POST",body:JSON.stringify(state)});
    saved.textContent=" · all saved";},400)};

const label=(f)=>state[f]?data.days.find(d=>d.slug===state[f])?.date??state[f]:"—";
const figs=new Map();
data.files.forEach((f,i)=>{
  const fig=$("figure",{},
    $("img",{src:"img/"+f,loading:"lazy",decoding:"async",alt:""}),
    $("div",{className:"cap"},$("span",{textContent:f}),$("span",{textContent:"#"+(i+1)})));
  const tag=$("span",{className:"tag",textContent:label(f)});
  fig.prepend(tag); fig.dataset.file=f; fig.dataset.i=i;
  figs.set(f,{fig,tag});
  grid.append(fig);
});
const paint=()=>{
  for(const [f,{fig,tag}] of figs){
    fig.classList.toggle("sel",sel.has(f));
    fig.classList.toggle("done",!!state[f]);
    tag.textContent=label(f); tag.classList.toggle("none",!state[f]);
  }
  count.textContent=sel.size?sel.size+" selected":"nothing selected";
  for(const b of bar.children){const n=data.files.filter(f=>state[f]===b.dataset.slug).length;
    b.classList.toggle("has",n>0);
    b.innerHTML="";
    const where=[b.dataset.location,b.dataset.country].filter(Boolean).join(", ");
    if(n)b.append($("span",{className:"n",textContent:n}));
    b.append($("span",{className:"d",textContent:b.dataset.date}));
    b.append($("span",{className:"w",textContent:(where||"no place named")+" · "+b.dataset.title}));}
};
grid.onclick=(e)=>{
  const fig=e.target.closest("figure"); if(!fig) return;
  const i=Number(fig.dataset.i), f=fig.dataset.file;
  if(e.shiftKey&&last!==null){
    const [a,b]=[Math.min(i,last),Math.max(i,last)];
    for(let k=a;k<=b;k++) sel.add(data.files[k]);
  } else { sel.has(f)?sel.delete(f):sel.add(f); last=i; }
  paint();
};
for(const d of data.days){
  const b=$("button",{});
  b.dataset.slug=d.slug; b.dataset.date=d.date; b.dataset.title=d.title;
  b.dataset.location=d.location||""; b.dataset.country=d.country||"";
  b.onclick=()=>{ if(!sel.size)return; for(const f of sel) state[f]=d.slug; sel.clear(); paint(); save(); };
  bar.append(b);
}
const clear=$("button",{id:"clear",textContent:"take the day off these"});
clear.onclick=()=>{ if(!sel.size)return; for(const f of sel) delete state[f]; sel.clear(); paint(); save(); };
bar.append(clear);
paint(); saved.textContent=" · all saved";
</script>`.replace(/__TRIP__/g, trip).replace(/__INTO__/g, into);

createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]).replace(/^\//, "");
  if (url === "" ) return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML);
  if (url === "favicon.ico") return res.writeHead(204).end();
  if (url === "logo.svg") return createReadStream(join(HERE, "assets", "fernscout-logo.svg"))
    .pipe(res.writeHead(200, { "content-type": "image/svg+xml" }));
  if (url === "data") {
    let assign = {};
    try { assign = JSON.parse(await readFile(STATE, "utf8")) } catch {}
    return res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ files, days: DAYS, assign }));
  }
  if (url === "save" && req.method === "POST") {
    const chunks = []; for await (const c of req) chunks.push(c);
    await writeFile(STATE, JSON.stringify(JSON.parse(Buffer.concat(chunks)), null, 2));
    return res.writeHead(204).end();
  }
  if (url.startsWith("img/")) {
    const name = url.slice(4);
    if (!files.includes(name)) return res.writeHead(404).end();
    return createReadStream(join(THUMBS, name))
      .pipe(res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "max-age=86400" }));
  }
  res.writeHead(404).end();
}).listen(PORT, "127.0.0.1", () => {
  const at = `http://127.0.0.1:${PORT}`;
  console.log(`${files.length} photographs · ${DAYS.length} days in ${into} → ${at}`);
  try { execFileSync("open", [at]) } catch {}
});
