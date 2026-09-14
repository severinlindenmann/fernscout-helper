#!/usr/bin/env node
// A journal folder and the instance, kept in step — both ways.
//
//   node sync.mjs down --user severin        bring the site's newest down here
//   node sync.mjs up   --user severin        send what changed here up
//   node sync.mjs down --user severin --dry-run     say what would move
//   node sync.mjs up   --user severin --prefer-local    resolve conflicts my way
//   node sync.mjs down --user severin --yes  allow it to prune local files
//
// B491, the client half of B1495. The server ships two read-only routes — a
// manifest of every path, size and hash, and a file `GET` — and nothing else:
// there is deliberately **no file `PUT`**, because a raw byte door onto a day
// would bypass every validator the instance has and become a door through
// which an agent writes a temperature nobody measured. So the down leg fetches
// bytes and the up leg goes through the same typed routes `publish` already
// calls.
//
// The two legs being different mechanisms is therefore the design rather than
// an omission — but it is worth saying out loud, because "sync" suggests a
// mirror in both directions and only the down leg is one.
//
// ## What this does not do, and why that is not an oversight
//
// **It never deletes anything on the site.** It names what a person deleted
// locally and stops there. That started as caution and ended as the only
// reading of the code that holds: `DELETE …/trips/<trip>/days` refuses a
// **published** day outright, with no confirmation code that could ever
// satisfy it, because destroying content people have already read is not a
// self-served round trip (B224, B1118) — and a day that has been on the site
// is the ordinary case in a journal worth syncing. A draft needs a signed
// `confirm` code handshake of its own. Neither is a decision a file diff gets
// to make. Taking a day off the site is `unpublish`, and it is editorial.
//
// **It never touches `gps/`.** No route on either side can return a
// coordinate, and the position store is unreachable from the manifest by
// test rather than by comment. Deleting `gps/` leaves every trip rendering
// identically, which is the property that makes the folder safe at all.
//
// **`originals/` come down with everything else**, since fernscout's B1719.
// They used to stay on the server — they are what a photobook prints from and
// an order of magnitude larger than what the site serves — and every run said
// how many files and bytes it had not fetched. That was honest and it was
// still a backup that gave back every photograph at a quarter of its pixels,
// to an owner with no filesystem to fetch the masters from. A first pull is
// now as large as the journal really is; a second one carries only what the
// hashes say changed.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { arg, has } from "../shared/lib.mjs";
import { SITE, call, token } from "../shared/api.mjs";
import { CONTENT } from "../shared/journal.mjs";
import {
  contentHash, deletionRefusal, localManifest, plan, readBase, writeBase,
} from "../shared/syncManifest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [direction] = process.argv.slice(2);
const user = arg("user");
const dry = has("dry-run");
const yes = has("yes");
const preferLocal = has("prefer-local");
const preferRemote = has("prefer-remote");

const die = (message) => { console.error(message); process.exit(1); };

if (direction !== "up" && direction !== "down") {
  die("Which way? node sync.mjs down --user <username>   (or: up)");
}
if (!user) die("Which journal? node sync.mjs " + direction + " --user <username>");
if (preferLocal && preferRemote) {
  die("--prefer-local and --prefer-remote say opposite things. Pick one, or neither and read the conflicts.");
}
try { token(); } catch (missing) { die(missing.message); }

const dir = join(CONTENT, user);
const bytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} kB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);

// ── what each side holds ───────────────────────────────────────────────────
const answer = await call("GET", `/api/v2/${user}/sync/manifest`);
if (!answer.ok) {
  die(answer.status === 404
    ? `${SITE} answered 404 for ${user}'s manifest. Either there is no such journal, or this ` +
      `token is scoped to one trip — a sync reads the whole journal, so it needs the owner's.`
    : `GET /api/v2/${user}/sync/manifest — ${answer.status} ${answer.body?.error ?? ""}`);
}
const remote = Object.fromEntries((answer.body.files ?? []).map((f) => [f.path, { size: f.size, hash: f.hash }]));

mkdirSync(dir, { recursive: true });
const base = readBase(dir);
const local = localManifest(dir, base.files);

/**
 * Is this side's idea of what belongs in a sync wider than the server's?
 *
 * `inSync()` here is a copy of the rule in the fernscout repo, because there
 * is no door that publishes it — and a copy of a rule disagrees with itself
 * within a month. This is the check that keeps the copy honest: anything this
 * walk admitted that the server's manifest does not list, and that the server
 * does hold, means the two rules have drifted. It costs one set difference and
 * it is the reason the copy is acceptable at all.
 *
 * Only meaningful once there has been a sync — before that, a local-only file
 * is the ordinary case of a folder the site has never seen.
 */
if (!base.fresh) {
  const drifted = Object.keys(local).filter((path) => !(path in remote) && path in base.files);
  if (drifted.length) {
    console.log(
      `  note: ${drifted.length} path${drifted.length === 1 ? "" : "s"} this run counts as syncable ` +
      `${drifted.length === 1 ? "is" : "are"} not in the site's manifest, though a previous sync had ` +
      `${drifted.length === 1 ? "it" : "them"} — the two exclusion rules may have drifted. First: ${drifted[0]}`,
    );
  }
}

const actions = plan({ base: base.files, local, remote });
const of = (name) => actions.filter((a) => a.action === name);

console.log(`${SITE} · content/${user} · sync ${direction}${dry ? " · dry run, nothing is written" : ""}`);
console.log(
  `  ${Object.keys(remote).length} files on the site, ${Object.keys(local).length} here` +
  (base.fresh ? ", no previous sync" : `, last synced ${base.syncedAt ?? "at some point"}`),
);
if (base.fresh) {
  const total = Object.values(remote).reduce((n, f) => n + f.size, 0);
  console.log(`  no previous sync, so this pulls the whole journal — ${bytes(total)}, originals included.`);
}

// ── conflicts ──────────────────────────────────────────────────────────────
let conflicts = of("conflict");
if (conflicts.length && (preferLocal || preferRemote)) {
  for (const c of conflicts) c.action = preferLocal ? "push" : "pull";
  console.log(`  ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} resolved ${preferLocal ? "in this folder's favour" : "in the site's favour"}.`);
  conflicts = [];
}
if (conflicts.length) {
  console.error(`\n✗ ${conflicts.length} file${conflicts.length === 1 ? "" : "s"} changed on both sides since the last sync. Nothing was written.\n`);
  for (const c of conflicts) console.error(`    ${c.path}  — ${c.reason}`);
  console.error(
    "\nSilently overwriting a day somebody wrote on the site is the same class of harm as\n" +
    "inventing one, so this stops rather than choosing. Look at them, then re-run with\n" +
    "--prefer-local or --prefer-remote, or reconcile the files by hand.",
  );
  process.exit(1);
}

// ── the plan, printed before anything moves ────────────────────────────────
const pulls = of("pull");
const pushes = of("push");
const pruneLocal = of("delete-local");
const goneRemote = of("delete-remote");
const moving = direction === "down" ? pulls : pushes;
const movingBytes = moving.reduce((n, a) => n + ((direction === "down" ? remote : local)[a.path]?.size ?? 0), 0);

console.log(
  `  plan: ${direction === "down" ? "pull" : "push"} ${moving.length} (${bytes(movingBytes)}), ` +
  `unchanged ${Object.keys(direction === "down" ? remote : local).length - moving.length}` +
  (direction === "down" ? `, local-only ${pushes.length}` : `, site-only ${pulls.length}`),
);
for (const a of moving) console.log(`    ${direction === "down" ? "↓" : "↑"} ${a.path}  — ${a.reason}`);

/**
 * Deletions, each side treated as what it actually is.
 *
 * Pruning this folder is reversible by running the sync again, so it happens
 * behind `--yes`. Deleting on the site is not reversible and is not this
 * script's to do at all — see the note at the top of the file.
 */
if (direction === "down" && pruneLocal.length) {
  const refusal = deletionRefusal(actions, { local, remote });
  if (refusal) {
    console.error(
      `\n✗ This would delete ${refusal.count} of ${refusal.total} files in ${refusal.side}. Refused, not ` +
      `confirmed.\n\nMore than half is the shape of an accident rather than an edit — a wiped folder, a\n` +
      `--user pointing at the wrong journal, an unzip that stopped half way. If it really is\n` +
      `what you meant, delete them by hand and run again.`,
    );
    process.exit(1);
  }
  console.log(`\n  ${pruneLocal.length} file${pruneLocal.length === 1 ? "" : "s"} deleted on the site and still here:`);
  for (const a of pruneLocal) console.log(`    ✕ ${a.path}`);
  if (!yes) {
    console.log("\n  Not pruned. Re-run with --yes to remove them from this folder.");
  }
}
if (direction === "up" && goneRemote.length) {
  console.log(`\n  ${goneRemote.length} file${goneRemote.length === 1 ? "" : "s"} gone from this folder and still on the site:`);
  for (const a of goneRemote) console.log(`    ✕ ${a.path}`);
  console.log(
    "\n  Nothing was deleted there, and this script will not do it. A published day is refused\n" +
    "  by the delete route outright — destroying what people have already read is not a\n" +
    "  self-served round trip — and taking one off the site is an editorial decision:\n" +
    `    POST /api/v2/${user}/trips/<trip>/days/<slug>/unpublish\n` +
    `    DELETE /api/v2/${user}/trips/<trip>/days/<slug>      (drafts only)`,
  );
}

if (dry) {
  console.log("\nDry run — nothing was written on either side.");
  process.exit(0);
}

// ── do it ──────────────────────────────────────────────────────────────────
if (direction === "down") {
  for (const a of pulls) {
    // ponytail: one request per file, which is right for the incremental case
    // this exists for and is a lot of round trips on a first sync of a large
    // journal. `/<user>/export.zip` is the bulk door if that ever bites —
    // byte-faithful for everything it carries, minus `track.json`, which it
    // ships and the manifest excludes.
    const response = await fetch(`${SITE}/api/v2/${user}/sync/file/${a.path.split("/").map(encodeURIComponent).join("/")}`, {
      headers: { authorization: `Bearer ${token()}` },
    });
    if (!response.ok) die(`GET …/sync/file/${a.path} — ${response.status}. Nothing further was fetched.`);
    const body = Buffer.from(await response.arrayBuffer());
    // Verified rather than assumed: the manifest said what these bytes hash
    // to, and a transfer that quietly truncated is exactly the failure a
    // mirror must not inherit.
    const got = contentHash(body);
    if (got !== remote[a.path].hash) {
      die(`${a.path} arrived as ${got}, the manifest said ${remote[a.path].hash}. Nothing further was fetched.`);
    }
    mkdirSync(dirname(join(dir, a.path)), { recursive: true });
    writeFileSync(join(dir, a.path), body);
  }
  if (yes) for (const a of pruneLocal) rmSync(join(dir, a.path), { force: true });
  console.log(`\nPulled ${pulls.length} file${pulls.length === 1 ? "" : "s"}${yes && pruneLocal.length ? `, pruned ${pruneLocal.length}` : ""}.`);
} else {
  if (!pushes.length) {
    console.log("\nNothing to send.");
  } else {
    /**
     * The up leg is `publish`, told what changed.
     *
     * Not a second implementation of it: `publish.mjs` is where every typed
     * route, every refusal and every hard-won piece of ordering lives, and a
     * sync that re-derived any of that would be the two-places-disagree
     * problem with somebody's journal in the middle. What this adds is the
     * one thing publish never had — a hash — so `--changed` narrows it to the
     * files that actually differ rather than re-`PATCH`ing fourteen days to
     * correct one. On a 51-day journal that is the difference between three
     * requests and a hundred and fifty.
     */
    const changedAt = join(dir, ".fernscout-sync-changed.json");
    writeFileSync(changedAt, JSON.stringify(pushes.map((a) => a.path)));
    // Publish's own flags, passed through rather than re-invented — `--drafts`
    // above all, which is the difference between writing the days and putting
    // them on the site, and is a person's word either way.
    const passed = ["drafts"].filter(has).map((f) => `--${f}`);
    const trip = arg("trip");
    try {
      execFileSync(process.execPath, [
        join(HERE, "../publish/publish.mjs"), "--user", user, "--changed", changedAt,
        ...(trip ? ["--trip", trip] : []), ...passed,
      ], { stdio: "inherit" });
    } catch {
      die("\npublish reported a problem, above. What already landed stays; the sync state was not updated,\nso running this again picks up from where it stopped.");
    } finally {
      rmSync(changedAt, { force: true });
    }
  }
}

// ── remember where both sides stood ────────────────────────────────────────
//
// Re-read from the server rather than assumed: the up leg goes through typed
// routes that normalise what they are given — frontmatter key order, a slug
// the instance assigns — so what landed is not always byte-for-byte what was
// sent, and a base manifest recording the guess would make every later run
// think that file had changed again.
const after = await call("GET", `/api/v2/${user}/sync/manifest`);
if (!after.ok) {
  console.log("\nCould not re-read the manifest, so the sync state was left as it was. The next run will work it out again.");
  process.exit(0);
}
const settled = Object.fromEntries((after.body.files ?? []).map((f) => [f.path, { size: f.size, hash: f.hash }]));
const here = localManifest(dir, base.files);
/**
 * What to remember, and what to leave alone.
 *
 * A base entry records **both sides** — what this folder held and what the
 * site held — because the up leg goes through typed routes that normalise
 * what they are given, so a file that landed perfectly is not byte-identical
 * to the one that was sent. Recording one hash made every successful push
 * into a permanent conflict; a real drive is what found that.
 *
 * Only paths this run actually settled are written: the ones it moved, and
 * the ones it found nothing to do about. A path still carrying a pending
 * action — a conflict, a local edit the down leg did not push, a deletion
 * nobody confirmed — keeps its previous entry, because recording it now would
 * quietly declare the pending thing done.
 */
/**
 * Did each thing this run said it would push actually land?
 *
 * **This is the check whose absence made the worst kind of bug possible.**
 * `config.json` is in the manifest, so a `sync up` planned a push for it, said
 * `↑ config.json — changed locally`, handed the list to `publish` — which had
 * no door for the journal document at all — and then wrote the sync state
 * recording that both sides agreed. The next `sync down` therefore had nothing
 * to pull, and an owner's renamed journal was gone for good, silently. That is
 * verbatim the failure `syncManifest.mjs`'s own header warns about: a changed
 * file never synced in either direction while both sides believe they agree.
 *
 * The journal now has a door (publish sends it), and this is the guard for
 * whatever the next one is: a pushed path whose remote hash did not move —
 * or which is still not there at all — is **not** recorded as agreed, is named
 * out loud, and makes the run exit non-zero. The next run then plans it again
 * rather than believing a push that never happened.
 *
 * Note what it does not claim: a push that landed is not required to arrive
 * byte-identical, because the typed routes normalise what they are given.
 * "Did the remote move" is the question a client can honestly ask.
 */
function landed(action) {
  const before = base.files[action.path];
  const after = settled[action.path];
  if (!after) return false;                      // still not there
  if (!before) return true;                      // new, and now on the site
  return after.hash !== (before.remote ?? before.hash);
}

const stalled = direction === "up" ? pushes.filter((a) => !landed(a)) : [];
if (stalled.length) {
  console.error(
    `\n✗ ${stalled.length} file${stalled.length === 1 ? "" : "s"} ${stalled.length === 1 ? "was" : "were"} planned for the site and ` +
    `${stalled.length === 1 ? "did" : "do"} not appear to have landed:`,
  );
  for (const a of stalled) console.error(`    ↑ ${a.path}  — ${a.reason}`);
  console.error(
    "\nThe sync state does NOT record these as agreed, so the next run will plan them again\n" +
    "rather than believing a push that did not happen. Read what publish printed above: a\n" +
    "path with no door on the instance is the shape this guard exists for.",
  );
}

const pending = new Set([...actions.map((a) => a.path), ...stalled.map((a) => a.path)]);
const moved = new Set(moving.filter((a) => direction === "down" || landed(a)).map((a) => a.path));
const files = { ...base.files };
for (const path of new Set([...Object.keys(here), ...Object.keys(settled)])) {
  if (pending.has(path) && !moved.has(path)) continue;
  if (!here[path] || !settled[path]) { delete files[path]; continue; }
  files[path] = { ...here[path], remote: settled[path].hash };
}
writeBase(dir, { site: SITE, user, files, syncedAt: new Date().toISOString() });
console.log(`Sync state written — ${Object.keys(files).length} file${Object.keys(files).length === 1 ? "" : "s"} both sides agree on.`);
if (stalled.length) process.exit(1);
