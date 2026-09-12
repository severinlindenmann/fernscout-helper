// A local journal folder, described the way the instance describes its own —
// and the three-way compare that says what moves. B491, the client half of
// B1495.
//
// Everything here is pure enough to test without a server: a walk, a hash, a
// file of remembered state, and a table. `sync.mjs` is what talks to the
// network.
//
// ## The hash is the whole file, and it matches the server's exactly
//
// `contentHash` in the fernscout repo (`lib/ingest/hash.ts:156`) is SHA-256
// over every byte, hex, cut to 32 characters. Reproduced here rather than
// fetched because it is the one thing both sides must agree on before any
// conversation is possible — and it is three lines, so the copy is cheaper
// than the door.
//
// Deliberately not the sampled hash beside it, for the reason B1495 wrote
// down: a sampled collision in ingest means a photograph is skipped and you
// add it again, while a sampled collision *here* means a changed file is
// never synced in either direction and both sides go on believing they agree.
// Invisible, and permanent.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The client's own state file, in the journal's root. Never synced — the
 * server's `inSync()` refuses it too, so a folder copied onto the instance by
 * hand cannot publish somebody's sync state either. */
export const BASE_MANIFEST_FILE = ".fernscout-sync.json";

export function contentHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

/**
 * Whether one path relative to `content/<user>/` belongs in a sync.
 *
 * **This mirrors `inSync()` in the fernscout repo's `lib/sync/manifest.ts`,
 * and a copy of a rule is a rule that disagrees with itself within a month.**
 * There is no door that publishes it, so a copy is what there is — but it is
 * not left to trust: `sync.mjs` compares this walk against the manifest the
 * server actually sent on every `down` run, and says so when this one turns
 * out to be the wider of the two. That check is the reason this copy is
 * acceptable, the same argument `content-model.snapshot.json` rests on.
 *
 * Lowercased before every comparison, because macOS is case-insensitive and
 * `ORIGINALS/01.jpg` resolves to the real folder. The server learned that one
 * from its own security pass; inheriting the bug here would mean offering to
 * push a print master the instance excludes.
 */
export function inSync(path) {
  if (!path || path.startsWith("/")) return false;
  const segments = path.split("/");
  if (segments.some((s) => s === "." || s === "..")) return false;
  if (segments.some((s) => s.startsWith("."))) return false;
  if (segments.length === 1) return path.toLowerCase() === "config.json";
  const root = segments[0].toLowerCase();
  if (root === "gps" || root === "postcards" || root === "photobooks") return false;
  if (root === "inbox") return segments.length >= 3;
  if (root !== "trips") return false;
  if (segments.length < 3) return false;
  if (segments[2].toLowerCase() === "originals") return false;
  if (segments.length === 3 && segments[2].toLowerCase() === "track.json") return false;
  return true;
}

/** Every file under `dir`, relative and POSIX-slashed, names sorted. */
function walkFiles(dir, root = dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, root, out);
    // `isFile()` is false for a symlink, which is what we want: the server's
    // own walk skips them for the same reason, and a link is not a file this
    // side can meaningfully claim to hold.
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

/**
 * The local folder, as a manifest of the same shape the server sends.
 *
 * `cache` is the previous run's file map — `{ path: { size, hash, mtimeMs } }`
 * — and turns an unchanged file into a `stat()` rather than a read. The key is
 * `(size, mtimeMs)` and it stays on this side: a modification time does not
 * survive a copy or an unzip and never agrees between two machines, which is
 * exactly why B1495 kept it off the wire.
 */
export function localManifest(dir, cache = {}) {
  const files = {};
  for (const path of walkFiles(dir)) {
    if (!inSync(path)) continue;
    let stat;
    try { stat = statSync(join(dir, path)); }
    catch { continue; }
    const seen = cache[path];
    const hash = seen && seen.size === stat.size && seen.mtimeMs === stat.mtimeMs
      ? seen.hash
      : contentHash(readFileSync(join(dir, path)));
    files[path] = { size: stat.size, hash, mtimeMs: stat.mtimeMs };
  }
  return files;
}

/** What the last sync left behind, or an empty one. A file that does not
 * parse is the same as no file: there is nothing to read out of it, and
 * throwing a syntax error at somebody whose sync state got truncated helps
 * nobody. It means every difference reads as a conflict, which is the safe
 * direction — nothing is written until a person says which side wins. */
export function readBase(dir) {
  const path = join(dir, BASE_MANIFEST_FILE);
  if (!existsSync(path)) return { files: {}, fresh: true };
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    if (!doc || typeof doc.files !== "object" || doc.files === null) return { files: {}, fresh: true };
    return { ...doc, files: doc.files, fresh: false };
  } catch {
    return { files: {}, fresh: true };
  }
}

export function writeBase(dir, { site, user, files, syncedAt }) {
  writeFileSync(
    join(dir, BASE_MANIFEST_FILE),
    JSON.stringify({ version: 1, instance: site, user, syncedAt, files }, null, 1),
  );
}

/**
 * base vs local vs remote, per path — B1495's table, and the reason the base
 * manifest exists at all: without it, "we differ" and "you changed it" are the
 * same observation.
 *
 * **A base entry remembers both sides**: `hash` is what this folder held at
 * the last sync and `remote` is what the site held. One hash for both was the
 * obvious version and it does not survive a real push — the up leg goes
 * through typed routes that normalise what they are given (frontmatter key
 * order, a slug the instance assigns), so a file that landed perfectly is
 * *not* byte-identical to the one that was sent. With one hash, every
 * successful push left the two sides permanently differing and the next run
 * called it a conflict. Asking "did each side move from where it was" instead
 * of "do the two agree" is what makes normalisation invisible, which is what
 * it should be.
 *
 * Actions: `pull`, `push`, `conflict`, `delete-remote`, `delete-local`.
 * A path with nothing to do does not appear.
 */
export function plan({ base, local, remote }) {
  const actions = [];
  const paths = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].sort();

  for (const path of paths) {
    const l = local[path]?.hash ?? null;
    const r = remote[path]?.hash ?? null;
    if (l === null && r === null) continue;   // gone from both; only base remembers it

    const b = base[path];
    if (!b) {
      // Never synced. One side has it and the other does not — or both wrote
      // the same path independently and neither is the base for the other.
      if (l !== null && r === null) actions.push({ path, action: "push", reason: "new locally" });
      else if (l === null && r !== null) actions.push({ path, action: "pull", reason: "new on the site" });
      else if (l !== r) actions.push({ path, action: "conflict", reason: "written on both sides, never synced" });
      continue;
    }

    const localMoved = l !== b.hash;
    const remoteMoved = r !== (b.remote ?? b.hash);
    // Neither side moved. They may still differ in bytes — that is the
    // normalisation a push leaves behind — and there is nothing to do about
    // it, which is the whole point of recording both.
    if (!localMoved && !remoteMoved) continue;

    if (localMoved && remoteMoved) {
      if (l === r) continue;   // both arrived at the same bytes; agreement is agreement
      actions.push({ path, action: "conflict", reason: "changed on both sides since the last sync" });
    } else if (remoteMoved) {
      actions.push(r === null
        ? { path, action: "delete-local", reason: "deleted on the site" }
        : { path, action: "pull", reason: "changed on the site" });
    } else {
      actions.push(l === null
        ? { path, action: "delete-remote", reason: "deleted locally" }
        : { path, action: "push", reason: "changed locally" });
    }
  }
  return actions;
}

/**
 * A deletion set large enough to be an accident rather than an edit.
 *
 * More than half the files on that side, and the run is **refused** rather
 * than confirmed — B1495's number, and the reasoning is that half is the
 * shape of a wiped folder, a `--root` pointing somewhere else, or an unzip
 * that stopped half way. An absolute count was the other candidate and is
 * worse: deleting a trip with forty photographs in it is ordinary on a large
 * journal and a catastrophe on a small one, and only a proportion knows the
 * difference.
 */
export const DELETION_REFUSAL_SHARE = 0.5;

export function deletionRefusal(actions, { local, remote }) {
  for (const [side, action, total] of [
    ["the site", "delete-remote", Object.keys(remote).length],
    ["this folder", "delete-local", Object.keys(local).length],
  ]) {
    const count = actions.filter((a) => a.action === action).length;
    if (count > 0 && total > 0 && count / total > DELETION_REFUSAL_SHARE) {
      return { side, count, total };
    }
  }
  return null;
}
