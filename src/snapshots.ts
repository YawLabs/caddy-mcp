import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Snapshot {
  config: unknown;
  timestamp: number;
  trigger: string;
}

const MAX_SNAPSHOTS = 10;
const store: Snapshot[] = [];

/**
 * A snapshot must be re-applyable via /load, which requires a JSON object root.
 * Strings, arrays, null, and primitives are not valid Caddy configs -- refuse to
 * capture them so a later `caddy_revert apply` can't replay garbage.
 *
 * Exported because both entry points into the ring have to agree: the in-memory
 * save path in tools/config.ts, and the rehydration path below. A file on disk
 * that merely parses as JSON is not automatically a config.
 */
export function isSnapshotableConfig(data: unknown): data is Record<string, unknown> {
  return data !== null && typeof data === "object" && !Array.isArray(data);
}

/** Matches the filenames persist() writes: snapshot-<epoch-ms>-<trigger>.json */
const SNAPSHOT_FILE_RE = /^snapshot-(\d+)-([\w-]+)\.json$/;

/**
 * Optional on-disk backing for the snapshot ring.
 *
 * Default (env unset) is the original behavior: an in-memory ring, per-process,
 * lost on restart. That is fine for a single interactive session but makes
 * `caddy_revert` read as more durable than it is -- the rollback target for a
 * bad `caddy_load` disappears if the MCP server is restarted in between.
 *
 * Setting CADDY_MCP_SNAPSHOT_DIR persists each snapshot as its own JSON file
 * and rehydrates the ring on first access, so rollback survives a restart.
 * Opt-in rather than default because it writes whole Caddy configs to disk,
 * and those can carry secrets (ACME EAB keys, upstream credentials) that the
 * operator should choose to place deliberately.
 */
function snapshotDir(): string | undefined {
  const dir = process.env.CADDY_MCP_SNAPSHOT_DIR?.trim();
  return dir ? dir : undefined;
}

let hydrated = false;

/** Read persisted snapshots into the ring once per process, newest first. */
function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const dir = snapshotDir();
  if (!dir || !existsSync(dir)) return;
  try {
    // Sort by NAME and take the newest MAX_SNAPSHOTS before reading anything:
    // the timestamp is already in the filename, so reading every file only to
    // discard all but ten would be blocking I/O proportional to whatever the
    // directory happens to hold. Timestamps are fixed-width epoch millis, so a
    // lexicographic sort matches a numeric one.
    const names = readdirSync(dir)
      .filter((n) => SNAPSHOT_FILE_RE.test(n))
      .sort()
      .reverse()
      .slice(0, MAX_SNAPSHOTS);
    const loaded: Snapshot[] = [];
    for (const name of names) {
      const m = SNAPSHOT_FILE_RE.exec(name);
      if (!m) continue;
      try {
        const config = JSON.parse(readFileSync(join(dir, name), "utf-8")) as unknown;
        // Same invariant the in-memory save path enforces. Without it, a
        // hand-edited or truncated-but-still-valid file ("str", [1,2], null)
        // would enter the ring and get POSTed to /load by `caddy_revert apply`.
        if (!isSnapshotableConfig(config)) continue;
        loaded.push({ config, timestamp: Number(m[1]), trigger: m[2] });
      } catch {
        // A corrupt or half-written snapshot must not take out the whole ring;
        // skip it and keep the ones that parse.
      }
    }
    loaded.sort((a, b) => b.timestamp - a.timestamp);
    store.push(...loaded);
  } catch {
    // An unreadable directory degrades to in-memory rather than failing the
    // tool call -- persistence is a convenience, not a correctness requirement.
  }
}

/** Mirror the in-memory ring to disk, pruning files beyond MAX_SNAPSHOTS. */
function persist(snap: Snapshot): void {
  const dir = snapshotDir();
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    // The trigger is embedded in the filename, so keep it filename-safe. It is
    // always one of our own literals today ("caddy_load", "manual",
    // "caddy_revert"); the sanitize keeps that true if a caller passes another.
    const safeTrigger = snap.trigger.replace(/[^\w-]/g, "_");
    writeFileSync(
      join(dir, `snapshot-${snap.timestamp}-${safeTrigger}.json`),
      JSON.stringify(snap.config, null, 2),
      "utf-8",
    );
    const files = readdirSync(dir)
      .filter((n) => SNAPSHOT_FILE_RE.test(n))
      .sort()
      .reverse();
    for (const stale of files.slice(MAX_SNAPSHOTS)) {
      rmSync(join(dir, stale), { force: true });
    }
  } catch {
    // Disk full, read-only mount, bad path -- the in-memory ring already holds
    // the snapshot, so the revert path still works for this process.
  }
}

export function saveSnapshot(config: unknown, trigger: string): void {
  hydrate();
  // Two snapshots inside the same millisecond would collide on the filename and
  // silently overwrite. Nudge forward so each keeps its own file and the ring's
  // ordering stays strict.
  let timestamp = Date.now();
  if (store.length > 0 && timestamp <= store[0].timestamp) {
    timestamp = store[0].timestamp + 1;
  }
  const snap: Snapshot = { config, timestamp, trigger };
  store.unshift(snap);
  if (store.length > MAX_SNAPSHOTS) {
    store.length = MAX_SNAPSHOTS;
  }
  persist(snap);
}

export function listSnapshots(): readonly Snapshot[] {
  hydrate();
  return store;
}

export function getSnapshot(index: number): Snapshot | undefined {
  hydrate();
  return store[index];
}

export function clearSnapshots(): void {
  store.length = 0;
  // Mark hydrated so a follow-up read does NOT pull the persisted set back in.
  // "Clear" that refills itself from disk on the next call would be the wrong
  // reading of the name. This empties the in-memory ring only; persisted files
  // are left alone, and a fresh process will load them again.
  hydrated = true;
}
