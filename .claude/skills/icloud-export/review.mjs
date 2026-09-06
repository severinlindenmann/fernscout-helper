#!/usr/bin/env node
// The page where a person decides which photos belong to the trip, and says
// what happened. Everything it collects is written to export/<trip>/review.json,
// which is what the agent reads afterwards.
//
//   node review.mjs --trip algarve-2026
import { createServer } from "node:http";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, arg, die, stemOf } from "../shared/lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const trip = arg("trip") ?? die("--trip <name> is required.");
const PORT = Number(arg("port") ?? 4321);
const DIR = join(ROOT, "export", trip);
const PHOTOS = join(DIR, "photos"), THUMBS = join(DIR, "thumbs"), STATE = join(DIR, "review.json");
if (!existsSync(PHOTOS)) die(`Nothing exported yet. Run export.mjs --trip ${trip} first.`);

const meta = new Map();
for (const p of JSON.parse(await readFile(join(DIR, "photos.json"), "utf8")).photos) meta.set(stemOf(p.name), p);

const files = (await readdir(PHOTOS)).filter((f) => /\.jpe?g$/i.test(f)).sort();
const photos = files.map((file) => {
  const m = meta.get(stemOf(file)) ?? {};
  return { file, day: m.day ?? "", time: m.time ?? "", place: m.place ?? "", fav: !!m.fav };
}).sort((a, b) => (a.day + a.time).localeCompare(b.day + b.time));

// A browser asked to decode 6 MB originals into 250px boxes crawls. Thumbnails
// are made once, with sips, which is already on every Mac.
let thumbed = [];
try { thumbed = await readdir(THUMBS) } catch {}
if (thumbed.filter((f) => /\.jpe?g$/i.test(f)).length !== files.length) {
  console.log(`making ${files.length} thumbnails…`);
  execFileSync("mkdir", ["-p", THUMBS]);
  execFileSync("sips", ["-Z", "500", "-s", "formatOptions", "65",
    ...files.map((f) => join(PHOTOS, f)), "--out", THUMBS], { stdio: "ignore" });
}

const HTML = String.raw`<!doctype html><meta charset="utf-8"><meta name=viewport content="width=device-width,initial-scale=1">
<title>Fernscout · iCloud Photo Helper</title>
<style>
 /* Fernscout palette. yellow-400 is a fill colour, never text: navy-900 on it. */
 :root{color-scheme:light;
   --cream-50:#fffaf0;--cream-100:#fff3dc;--cream-200:#ffe9bd;
   --navy-900:#1e293b;--navy-600:#44546c;--navy-200:#d8dee8;
   --yellow-400:#ffd23f;--green-700:#15803d;--coral-600:#c2334a;--blue-500:#2f6fed;
   --ok:var(--green-700);--no:var(--coral-600);--line:var(--navy-200)}
 *{box-sizing:border-box}
 body{font:17px/1.6 system-ui,-apple-system,sans-serif;margin:0;padding:0 1.5rem 8rem;max-width:1500px;
   background:var(--cream-50);color:var(--navy-900)}
 header{padding:1.5rem 0 .5rem}
 header img{height:44px;width:auto;display:block;margin-bottom:1rem}
 h1{font-size:1.6rem;margin:0 0 .5rem}
 .lede{margin:0 0 .6rem;max-width:46rem;color:var(--navy-600)}
 .lede b{color:var(--navy-900)}
 :focus-visible{outline:3px solid var(--blue-500);outline-offset:2px}
 h2{margin:2.5rem 0 .25rem;font-size:1.35rem;border-bottom:4px solid var(--yellow-400);display:inline-block;padding-bottom:.15rem}
 .where{margin:.35rem 0 .75rem;color:var(--navy-600)}
 .daybox{background:var(--cream-100);border:1px solid var(--cream-200);border-radius:10px;padding:1rem;margin-bottom:1.25rem}
 .daybox label{display:block;font-weight:600;margin-bottom:.35rem}
 .daybox .hint{font-weight:400;color:var(--navy-600);font-size:.9rem}
 textarea{width:100%;font:inherit;padding:.6rem;border-radius:8px;border:1px solid var(--line);background:#fff;color:inherit}
 .daynote{min-height:5rem}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:1.25rem}
 /* the one line that makes 600 cards scroll: no layout or paint off-screen */
 figure{margin:0;content-visibility:auto;contain-intrinsic-size:auto 420px}
 img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;display:block;cursor:pointer;background:var(--line)}
 figure.drop img{filter:grayscale(1);opacity:.35}
 .meta{display:flex;justify-content:space-between;gap:.5rem;font-size:.85rem;color:var(--navy-600);padding:.35rem .15rem}
 .meta a{color:inherit}
 .keep{width:100%;min-height:44px;font:inherit;font-weight:600;border-radius:8px;cursor:pointer;
       border:2px solid var(--ok);color:var(--ok);background:#fff}
 figure.drop .keep{border-color:var(--no);color:var(--no)}
 .vis{width:100%;min-height:40px;margin-top:.4rem;font:inherit;border-radius:8px;
       border:1px solid var(--line);background:#fff;color:inherit;padding:0 .4rem}
 /* Held back at all: enough to pick out of a grid of three hundred without
    shouting, since it is the uncommon case and not an error. */
 figure.held .vis{border:2px solid var(--blue-500);font-weight:600}
 .note{margin-top:.4rem;height:2.8rem;font-size:.95rem}
 #done{margin:3rem 0 0;padding:1.25rem 1.5rem;background:var(--cream-100);border:1px solid var(--cream-200);
       border-left:6px solid var(--yellow-400);border-radius:10px;max-width:46rem}
 #done h3{margin:0 0 .4rem}
 #bar{position:fixed;bottom:0;left:0;right:0;padding:.75rem 1.5rem;background:var(--cream-100);
      border-top:3px solid var(--yellow-400);display:flex;gap:1.25rem;align-items:center;flex-wrap:wrap}
 #bar select{font:inherit;padding:.4rem;border-radius:8px;border:1px solid var(--line);background:#fff;color:inherit}
 #saved{color:var(--navy-600)}
 @media (max-width:600px){body{padding:0 .75rem 8rem}.grid{gap:1rem}}
</style>
<header>
 <img src="/logo.svg" alt="Fernscout">
 <h1>__TRIP__ — choosing the photos</h1>
 <p class=lede>Go through the photos day by day and do two things.</p>
 <p class=lede><b>1.</b> If a picture does not belong to this trip — a screenshot, something somebody
  sent you — press <b>Keep</b> once to turn it off. Press it again to turn it back on.</p>
 <p class=lede><b>2.</b> Write a few words about each day in the big box. The journal text is written
  from those words, so anything you do not write there will not appear.</p>
 <p class=lede><b>3.</b> If one picture should be seen by fewer people than the rest of the day,
  say so under it: <b>Guests only</b> means everybody you have let into the journal,
  <b>Private</b> means only the people who were on the trip. It can only ever hide a photo from
  people the trip already lets in — it never shows one to anybody else.</p>
 <p class=lede>Everything saves by itself. You can close the page and come back.</p>
</header>
<div id=app>Loading the photos…</div>
<div id=done>
 <h3>When you are finished</h3>
 <p>Go back to the agent you started this from and say: <b>“I am done with the photos, please continue.”</b></p>
 <p class=lede>It reads your choices and your notes from <code>export/__TRIP__/review.json</code> and writes the journal.</p>
</div>
<div id=bar>
 <b id=stat></b><span id=saved></span>
 <label>Jump to day <select id=jump></select></label>
</div>
<script type=module>
const $ = (t, { dataset, ...a } = {}, ...c) => {
  const e = Object.assign(document.createElement(t), a);
  if (dataset) Object.assign(e.dataset, dataset);   // dataset is a getter — assign into it
  c.flat().forEach((x) => e.append(x)); return e;
};
const data = await (await fetch("/data")).json();
const state = data.review || {};
state.photos ??= {}; state.days ??= {};
const app = document.getElementById("app"), stat = document.getElementById("stat"),
      saved = document.getElementById("saved"), jump = document.getElementById("jump");

let timer;
const save = () => {
  clearTimeout(timer); saved.textContent = "saving…";
  timer = setTimeout(async () => {
    await fetch("/save", { method: "POST", body: JSON.stringify(state) });
    saved.textContent = "all saved";
  }, 400);
};
const st = (file) => (state.photos[file] ??= { drop: false, note: "", visibility: "" });
const count = () => {
  const dropped = data.photos.filter((p) => st(p.file).drop).length;
  stat.textContent = (data.photos.length - dropped) + " photos kept · " + dropped + " turned off";
};
const label = (dropped) => dropped ? "✕  Turned off" : "✓  Keep";
const human = (d) => new Date(d + "T12:00").toLocaleDateString(undefined,
  { weekday: "long", day: "numeric", month: "long", year: "numeric" });

const byDay = {};
for (const p of data.photos) (byDay[p.day] ??= []).push(p);
app.textContent = "";
for (const [day, list] of Object.entries(byDay)) {
  const id = "d" + day;
  app.append($("h2", { id, textContent: day ? human(day) : "Without a date" }));
  app.append($("p", { className: "where", textContent: list.length + " photos · " +
    [...new Set(list.map((p) => (p.place || "").split(",")[0]).filter(Boolean))].join(" · ") }));
  jump.append($("option", { value: id, textContent: day ? human(day) : "Without a date" }));

  const box = $("div", { className: "daybox" });
  const lab = $("label", { textContent: "What happened on this day? " });
  lab.append($("span", { className: "hint",
    textContent: "— where you went, what you ate, who you met. Half a sentence is fine." }));
  const dn = $("textarea", { className: "daynote", value: state.days[day] || "" });
  dn.oninput = () => { state.days[day] = dn.value; save() };
  box.append(lab, dn);
  app.append(box);

  const grid = $("div", { className: "grid" });
  for (const p of list) {
    const s = st(p.file);
    grid.append($("figure", { className: [s.drop && "drop", s.visibility && "held"]
      .filter(Boolean).join(" ") },
      $("img", { src: "/img/" + p.file, loading: "lazy", decoding: "async", alt: "", dataset: { file: p.file } }),
      $("div", { className: "meta" },
        $("span", { textContent: (p.fav ? "♥ " : "") + p.time }),
        $("a", { href: "/full/" + p.file, target: "_blank", textContent: "see it big ↗" })),
      $("button", { className: "keep", textContent: label(s.drop), dataset: { file: p.file } }),
      $("select", { className: "vis", dataset: { file: p.file } },
        [["", "Everyone who can see the trip"], ["guest", "Guests only"], ["private", "Private"]]
          .map(([value, text]) => $("option", { value, text, selected: s.visibility === value }))),
      $("textarea", { className: "note", placeholder: "A note about this photo (optional)",
        value: s.note, dataset: { file: p.file } })));
  }
  // one listener per day rather than three per photo
  grid.onclick = (e) => {
    const el = e.target.closest("img, button.keep"); if (!el) return;
    const s = st(el.dataset.file), fig = el.closest("figure");
    s.drop = !s.drop;
    fig.className = [s.drop && "drop", s.visibility && "held"].filter(Boolean).join(" ");
    fig.querySelector("button.keep").textContent = label(s.drop);
    count(); save();
  };
  grid.oninput = (e) => {
    if (e.target.matches("textarea.note")) { st(e.target.dataset.file).note = e.target.value; save() }
  };
  grid.onchange = (e) => {
    if (!e.target.matches("select.vis")) return;
    const s = st(e.target.dataset.file), fig = e.target.closest("figure");
    s.visibility = e.target.value;
    fig.className = [s.drop && "drop", s.visibility && "held"].filter(Boolean).join(" ");
    save();
  };
  app.append(grid);
}
jump.onchange = () => document.getElementById(jump.value).scrollIntoView({ behavior: "smooth" });
count(); saved.textContent = "all saved";
</script>`.replace(/__TRIP__/g, trip);

createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML);
  if (url === "/favicon.ico") return res.writeHead(204).end();
  if (url === "/logo.svg") return createReadStream(join(HERE, "assets", "fernscout-logo.svg"))
    .pipe(res.writeHead(200, { "content-type": "image/svg+xml" }));
  if (url === "/data") {
    let review = { photos: {}, days: {} };
    try { review = JSON.parse(await readFile(STATE, "utf8")) } catch {}
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ photos, review }));
  }
  if (url === "/save" && req.method === "POST") {
    const chunks = []; for await (const c of req) chunks.push(c);
    await writeFile(STATE, JSON.stringify(JSON.parse(Buffer.concat(chunks)), null, 2));
    return res.writeHead(204).end();
  }
  for (const [prefix, folder] of [["/img/", THUMBS], ["/full/", PHOTOS]]) {
    if (!url.startsWith(prefix)) continue;
    const name = url.slice(prefix.length);
    if (!files.includes(name)) return res.writeHead(404).end();
    return createReadStream(join(folder, name))
      .pipe(res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "max-age=86400" }));
  }
  res.writeHead(404).end();
}).listen(PORT, () => {
  const at = `http://localhost:${PORT}`;
  console.log(`${photos.length} photos → ${at}`);
  try { execFileSync("open", [at]) } catch {}
});
