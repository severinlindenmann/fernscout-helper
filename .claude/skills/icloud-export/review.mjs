#!/usr/bin/env node
// The page where a person decides which photos belong to the trip, and says
// what happened. Everything it collects is written to export/<trip>/review.json,
// which is what the agent reads afterwards.
//
//   node review.mjs                          every exported trip, with an index
//   node review.mjs --trip algarve-2026      straight into one of them
//   node review.mjs --port 4321 --no-open
//
// B1778: this was one trip per process. Ten years of a library came out as 26
// trips, which meant 26 servers on 26 ports and 26 tabs, with nothing saying
// which had been reviewed and which had not. One server now lists them at `/`
// and serves each at `/t/<trip>/`; a trip is prepared — baked, thumbnailed —
// the first time somebody opens it rather than all of them at startup.
import { createServer } from "node:http";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, arg, die, has, stemOf } from "../shared/lib.mjs";
import { ensureBaked } from "./bake.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const only = arg("trip");
const PORT = Number(arg("port") ?? 4321);
const EXPORTS = join(ROOT, "export");

/** An exported trip is a folder with photographs and a selection in it. */
function exportedTrips() {
  let names = [];
  try { names = readdirSync(EXPORTS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) }
  catch { return [] }
  return names.filter((name) =>
    existsSync(join(EXPORTS, name, "photos")) && existsSync(join(EXPORTS, name, "photos.json"))).sort();
}

const TRIPS = exportedTrips();
if (!TRIPS.length) die(`Nothing exported yet — no folder under export/ with photos in it.\n  node export.mjs --trip <name>`);
if (only && !TRIPS.includes(only)) {
  die(`Nothing exported for ${only}. Exported: ${TRIPS.join(", ")}\n  node export.mjs --trip ${only}`);
}

/**
 * Where a trip stands, read cheaply enough to do for all of them on every
 * load of the index: what is on disk, and what the person has decided so far.
 */
function progress(trip) {
  const DIR = join(EXPORTS, trip);
  let review = {};
  try { review = JSON.parse(readFileSync(join(DIR, "review.json"), "utf8")) } catch {}
  const decided = Object.values(review.photos ?? {});
  const photos = readdirSync(join(DIR, "photos")).filter((f) => /\.jpe?g$/i.test(f)).length;
  const days = Object.values(review.days ?? {}).filter((t) => String(t).trim()).length;
  const flags = Object.keys(review.flags ?? {}).length;
  return {
    trip, photos, days, flags,
    dropped: decided.filter((s) => s.drop).length,
    notes: decided.filter((s) => String(s.note ?? "").trim()).length,
    reviewed: decided.length > 0,
    prepared: prepared.has(trip),
  };
}

/**
 * One trip, ready to serve — the derivative of every photograph, and the
 * thumbnails made from those. The picture a person approves here has to be the
 * picture that gets published (B646): `ensureBaked` is the same
 * resize-turn-strip `build.mjs` runs, so a phone held sideways is already
 * upright here instead of relying on an Orientation tag the browser honours
 * and `build.mjs` bakes differently afterwards.
 *
 * Done on first request rather than at startup, because 26 trips of 1,100
 * photographs is a quarter of an hour before the index would appear.
 */
const prepared = new Map();
async function prepare(trip) {
  if (prepared.has(trip)) return prepared.get(trip);
  const DIR = join(EXPORTS, trip);
  const PHOTOS = join(DIR, "photos"), THUMBS = join(DIR, "thumbs");

  const meta = new Map();
  for (const p of JSON.parse(await readFile(join(DIR, "photos.json"), "utf8")).photos) meta.set(stemOf(p.name), p);

  const files = (await readdir(PHOTOS)).filter((f) => /\.jpe?g$/i.test(f)).sort();
  const photos = files.map((file) => {
    const m = meta.get(stemOf(file)) ?? {};
    return { file, day: m.day ?? "", time: m.time ?? "", place: m.place ?? "", fav: !!m.fav };
  }).sort((a, b) => (a.day + a.time).localeCompare(b.day + b.time));

  console.log(`preparing ${trip}: ${files.length} photo${files.length === 1 ? "" : "s"}…`);
  const baked = new Map(files.map((f) => [f, ensureBaked(DIR, PHOTOS, f)]));

  // A browser asked to decode 6 MB originals into 250px boxes crawls.
  // Thumbnails are made once, with sips, which is already on every Mac.
  let thumbed = [];
  try { thumbed = await readdir(THUMBS) } catch {}
  if (thumbed.filter((f) => /\.jpe?g$/i.test(f)).length !== files.length) {
    console.log(`  making ${files.length} thumbnails…`);
    execFileSync("mkdir", ["-p", THUMBS]);
    execFileSync("sips", ["-Z", "500", "-s", "formatOptions", "65",
      ...files.map((f) => baked.get(f)), "--out", THUMBS], { stdio: "ignore" });
  }

  const state = { trip, DIR, PHOTOS, THUMBS, STATE: join(DIR, "review.json"), files, photos, baked };
  prepared.set(trip, state);
  return state;
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
 /* What the photographs show, read from a contact sheet. A memory-jogger and
    never the journal's prose — it is deliberately not inside a field that
    saves, so it cannot be mistaken for something the author wrote. */
 .seen{margin:0 0 .9rem;padding:.7rem .9rem;background:#fff;border-radius:8px;
       border:1px solid var(--line);border-left:4px solid var(--navy-200);color:var(--navy-600);font-size:.95rem}
 .seen b{display:block;color:var(--navy-900);font-size:.85rem;text-transform:uppercase;
         letter-spacing:.04em;margin-bottom:.25rem}
 /* B1779: what somebody reading the contact sheets said is visible in this
    frame — a document, a card, a screen with a name on it. It marks, it does
    not decide: turning the photograph off is still a press. */
 figure.flagged{outline:3px solid var(--coral-600);outline-offset:4px;border-radius:12px}
 .flag{margin:.4rem 0 0;padding:.5rem .6rem;background:#fff;border:1px solid var(--no);
       border-left:5px solid var(--no);border-radius:8px;font-size:.9rem;color:var(--navy-900)}
 .flag b{display:block;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:var(--no)}
 #bar a{color:var(--navy-900)}
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
  from those words, so anything you do not write there will not appear. The grey box above it is
  only a list of what is visible in that day's pictures, to jog your memory — it is never used as text.</p>
 <p class=lede><b>3.</b> If one picture should be seen by fewer people than the rest of the day,
  say so under it: <b>Guests only</b> means everybody you have let into the journal,
  <b>Private</b> means only the people who were on the trip. It can only ever hide a photo from
  people the trip already lets in — it never shows one to anybody else.</p>
 <p class=lede><b>4.</b> A frame with a red border is one where something private was noticed —
  a document, a card, a screen with a name on it. It is only marked; you decide.</p>
 <p class=lede>Everything saves by itself. You can close the page and come back.</p>
 <p class=lede><a href="/">← all trips</a></p>
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
 <label id=flagbox hidden>Marked private <select id=flags></select></label>
 <a href="/">all trips</a>
</div>
<script type=module>
const $ = (t, { dataset, ...a } = {}, ...c) => {
  const e = Object.assign(document.createElement(t), a);
  if (dataset) Object.assign(e.dataset, dataset);   // dataset is a getter — assign into it
  c.flat().forEach((x) => e.append(x)); return e;
};
const data = await (await fetch("data")).json();
const state = data.review || {};
state.photos ??= {}; state.days ??= {};
const app = document.getElementById("app"), stat = document.getElementById("stat"),
      saved = document.getElementById("saved"), jump = document.getElementById("jump");

let timer;
const save = () => {
  clearTimeout(timer); saved.textContent = "saving…";
  timer = setTimeout(async () => {
    await fetch("save", { method: "POST", body: JSON.stringify(state) });
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
const flagged = [];
app.textContent = "";
for (const [day, list] of Object.entries(byDay)) {
  const id = "d" + day;
  app.append($("h2", { id, textContent: day ? human(day) : "Without a date" }));
  app.append($("p", { className: "where", textContent: list.length + " photos · " +
    [...new Set(list.map((p) => (p.place || "").split(",")[0]).filter(Boolean))].join(" · ") }));
  jump.append($("option", { value: id, textContent: day ? human(day) : "Without a date" }));

  const box = $("div", { className: "daybox" });
  if (state.observed?.[day])
    box.append($("p", { className: "seen" },
      $("b", { textContent: "What the photos show" }),
      document.createTextNode(state.observed[day])));
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
    const flag = state.flags?.[p.file];
    const fig = $("figure", { id: "f" + p.file.replace(/[^a-zA-Z0-9]/g, "-"),
      className: [s.drop && "drop", s.visibility && "held", flag && "flagged"].filter(Boolean).join(" ") },
      $("img", { src: "img/" + p.file, loading: "lazy", decoding: "async", alt: "", dataset: { file: p.file } }),
      $("div", { className: "meta" },
        $("span", { textContent: (p.fav ? "♥ " : "") + p.time }),
        $("a", { href: "full/" + p.file, target: "_blank", textContent: "see it big ↗" })),
      $("button", { className: "keep", textContent: label(s.drop), dataset: { file: p.file } }),
      $("select", { className: "vis", dataset: { file: p.file } },
        [["", "Everyone who can see the trip"], ["guest", "Guests only"], ["private", "Private"]]
          .map(([value, text]) => $("option", { value, text, selected: s.visibility === value }))),
      $("textarea", { className: "note", placeholder: "A note about this photo (optional)",
        value: s.note, dataset: { file: p.file } }));
    if (flag) {
      fig.append($("p", { className: "flag" }, $("b", { textContent: "Something private here" }),
        document.createTextNode(flag)));
      flagged.push({ file: p.file, day, flag });
    }
    grid.append(fig);
  }
  // one listener per day rather than three per photo
  grid.onclick = (e) => {
    const el = e.target.closest("img, button.keep"); if (!el) return;
    const s = st(el.dataset.file), fig = el.closest("figure");
    s.drop = !s.drop;
    fig.className = [s.drop && "drop", s.visibility && "held", state.flags?.[el.dataset.file] && "flagged"]
      .filter(Boolean).join(" ");
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
    fig.className = [s.drop && "drop", s.visibility && "held", state.flags?.[e.target.dataset.file] && "flagged"]
      .filter(Boolean).join(" ");
    save();
  };
  app.append(grid);
}
jump.onchange = () => document.getElementById(jump.value).scrollIntoView({ behavior: "smooth" });

// B1779: whoever looked at the contact sheets found these; without a way in,
// the person hunts the page by date for a frame they were told about.
const flagSelect = document.getElementById("flags"), flagBox = document.getElementById("flagbox");
if (flagged.length) {
  flagBox.hidden = false;
  flagSelect.append($("option", { value: "", textContent: flagged.length + " to look at" }));
  for (const f of flagged) {
    flagSelect.append($("option", { value: "f" + f.file.replace(/[^a-zA-Z0-9]/g, "-"),
      textContent: f.day + " — " + f.flag.slice(0, 60) }));
  }
  flagSelect.onchange = () => {
    if (flagSelect.value) document.getElementById(flagSelect.value).scrollIntoView({ behavior: "smooth", block: "center" });
  };
}
count(); saved.textContent = "all saved";
</script>`;

/** The review page for one trip. Served at `/t/<trip>/`, with the trailing
 * slash, so every relative URL in it (`data`, `save`, `img/…`) lands inside
 * the trip rather than at the root. */
const page = (trip) => HTML.replace(/__TRIP__/g, trip);

/**
 * The index — B1778.
 *
 * Not a nicety: 26 trips meant 26 servers, and nothing anywhere said which of
 * them had been through a review. Each row says what is on disk and what the
 * person has decided so far, so "what is left to do" is one page.
 */
const indexPage = () => String.raw`<!doctype html><meta charset="utf-8">
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Fernscout · the exported trips</title>
<style>
 :root{color-scheme:light;--cream-50:#fffaf0;--cream-100:#fff3dc;--cream-200:#ffe9bd;
   --navy-900:#1e293b;--navy-600:#44546c;--navy-200:#d8dee8;--yellow-400:#ffd23f;
   --green-700:#15803d;--coral-600:#c2334a}
 *{box-sizing:border-box}
 body{font:17px/1.6 system-ui,-apple-system,sans-serif;margin:0;padding:0 1.5rem 4rem;max-width:60rem;
   background:var(--cream-50);color:var(--navy-900)}
 header{padding:1.5rem 0 .5rem}
 header img{height:44px;width:auto;display:block;margin-bottom:1rem}
 h1{font-size:1.6rem;margin:0 0 .5rem}
 p.lede{margin:0 0 .6rem;max-width:44rem;color:var(--navy-600)}
 table{border-collapse:collapse;width:100%;margin-top:1.5rem;background:var(--cream-100);
   border:1px solid var(--cream-200);border-radius:10px;overflow:hidden}
 th,td{text-align:left;padding:.6rem .8rem;border-bottom:1px solid var(--cream-200);font-variant-numeric:tabular-nums}
 th{font-size:.85rem;text-transform:uppercase;letter-spacing:.04em;color:var(--navy-600)}
 tr:last-child td{border-bottom:0}
 td.n{text-align:right}
 a{color:var(--navy-900);font-weight:600}
 .done{color:var(--green-700)}
 .todo{color:var(--navy-600)}
 .flag{color:var(--coral-600);font-weight:600}
 @media (max-width:600px){body{padding:0 .75rem 4rem}th:nth-child(4),td:nth-child(4){display:none}}
</style>
<header>
 <img src="/logo.svg" alt="Fernscout">
 <h1>The exported trips</h1>
 <p class=lede>Open one and go through its photographs. Everything saves by itself, and you can
  come back to any of them.</p>
 <p class=lede>When you have finished the ones you care about, go back to the agent you started
  this from and say so.</p>
</header>
<table>
 <tr><th>Trip</th><th class=n>Photos</th><th class=n>Turned off</th><th class=n>Days written</th><th>State</th></tr>
 ${TRIPS.map(progress).map((p) => `<tr>
   <td><a href="/t/${encodeURIComponent(p.trip)}/">${p.trip}</a></td>
   <td class=n>${p.photos}</td>
   <td class=n>${p.reviewed ? p.dropped : "—"}</td>
   <td class=n>${p.days || "—"}</td>
   <td>${p.reviewed ? '<span class=done>reviewed</span>' : '<span class=todo>not yet</span>'}${
     p.flags ? ` · <span class=flag>${p.flags} marked private</span>` : ""}</td>
 </tr>`).join("")}
</table>`;

createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split("?")[0]);
  if (path === "/favicon.ico") return res.writeHead(204).end();
  if (path === "/logo.svg") return createReadStream(join(HERE, "assets", "fernscout-logo.svg"))
    .pipe(res.writeHead(200, { "content-type": "image/svg+xml" }));
  if (path === "/") {
    return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(indexPage());
  }
  if (path === "/index.json") {
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(TRIPS.map(progress)));
  }

  const match = path.match(/^\/t\/([^/]+)(\/.*)?$/);
  if (!match) return res.writeHead(404).end();
  const [, trip, rest = "/"] = match;
  if (!TRIPS.includes(trip)) return res.writeHead(404).end(`No export for ${trip}`);
  // A page without the trailing slash would resolve `img/x` one level up.
  if (rest === "") return res.writeHead(302, { location: `/t/${encodeURIComponent(trip)}/` }).end();

  const t = await prepare(trip);
  const url = rest;
  if (url === "/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(trip));
  if (url === "/data") {
    let review = { photos: {}, days: {} };
    try { review = JSON.parse(await readFile(t.STATE, "utf8")) } catch {}
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ photos: t.photos, review }));
  }
  if (url === "/save" && req.method === "POST") {
    const chunks = []; for await (const c of req) chunks.push(c);
    const incoming = JSON.parse(Buffer.concat(chunks));
    // Whatever else is in the file stays in it. `observed` and `flags` are
    // written by whoever read the contact sheets, not by this page, and a save
    // that replaced the whole document would quietly delete them.
    let existing = {};
    try { existing = JSON.parse(await readFile(t.STATE, "utf8")) } catch {}
    await writeFile(t.STATE, JSON.stringify({ ...existing, ...incoming }, null, 2));
    return res.writeHead(204).end();
  }
  if (url.startsWith("/img/")) {
    const name = url.slice("/img/".length);
    if (!t.files.includes(name)) return res.writeHead(404).end();
    return createReadStream(join(t.THUMBS, name))
      .pipe(res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "max-age=86400" }));
  }
  if (url.startsWith("/full/")) {
    const name = url.slice("/full/".length);
    if (!t.files.includes(name)) return res.writeHead(404).end();
    // The baked derivative, not the original — see it big should mean see
    // what will actually be published, orientation and all.
    return createReadStream(t.baked.get(name))
      .pipe(res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "max-age=86400" }));
  }
  res.writeHead(404).end();
}).listen(PORT, "127.0.0.1", async () => {
  const at = `http://127.0.0.1:${PORT}`;
  if (only) {
    await prepare(only);
    console.log(`${only} → ${at}/t/${encodeURIComponent(only)}/`);
  } else {
    console.log(`${TRIPS.length} exported trip(s) → ${at}`);
    for (const p of TRIPS.map(progress)) {
      console.log(`  ${p.trip.padEnd(24)} ${String(p.photos).padStart(5)} photos  ` +
        `${p.reviewed ? `${p.dropped} turned off, ${p.days} day(s) written` : "not reviewed yet"}` +
        `${p.flags ? `  · ${p.flags} marked private` : ""}`);
    }
  }
  // `--no-open` is for a test, and for anybody running this over ssh.
  const open = only ? `${at}/t/${encodeURIComponent(only)}/` : at;
  if (!has("no-open")) { try { execFileSync("open", [open]) } catch {} }
});
