import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Status files hold prompt text and exact Jev exchanges, so only the owner may read them.
// On Linux the temp dir is the shared /tmp; macOS and Windows temp dirs are already per-user,
// where these modes are harmless (Windows ignores them).
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const POSIX = typeof process.getuid === "function";

// Files not updated for this long belong to finished sessions and are removed.
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Where the default store writes. The directory is still named for Claude because live
 * sessions and `jev-explain` already read it; renaming it would strand in-flight status.
 * On POSIX the name includes the uid: /tmp is shared, and a fixed name would let another
 * user create the directory (or a symlink) first. Windows temp dirs are already per-user.
 * `JEV_STATUS_DIR` overrides it for diagnostics.
 */
export const DEFAULT_STATUS_DIR =
  process.env.JEV_STATUS_DIR || join(tmpdir(), POSIX ? `jev-claude-${process.getuid()}` : "jev-claude");

/**
 * Builds a status store rooted at `dir`.
 *
 * Harnesses that must not share a directory — and tests, which otherwise scribble into the
 * real one — take their own store instead of the module-level functions below.
 */
export function createStatusStore({ dir = DEFAULT_STATUS_DIR } = {}) {
  // One file per session rather than a shared map, so concurrent sessions can never clobber
  // each other's status. Kept in the temp dir so the OS eventually cleans up.
  const fileFor = (sessionId) => join(dir, `${sessionId.replace(/[^\w-]/g, "")}.json`);

  // Pruning runs once per store, on its first write.
  let pruned = false;

  /**
   * Create the private directory if needed and return its path. Throws if the path is a
   * symlink or not owned by the current user, so nothing is written where someone else
   * controls it. Takes an explicit path only for diagnostics/tests; normal callers rely on
   * the store's own `dir`.
   */
  function ensurePrivateDir(target = dir) {
    mkdirSync(target, { recursive: true, mode: DIR_MODE });
    if (POSIX) {
      const info = lstatSync(target);
      if (!info.isDirectory() || info.uid !== process.getuid()) {
        throw new Error(`${target} is not a directory owned by the current user`);
      }
    }
    // Directories created by earlier versions were world-readable. chmod fails if another user
    // owns the directory, in which case the write below fails too and status is skipped.
    chmodSync(target, DIR_MODE);
    return target;
  }

  /** Publish the latest routing decision so the status line can display it. */
  function writeStatus(sessionId, status) {
    if (!sessionId) return;
    try {
      ensurePrivateDir();
      const file = fileFor(sessionId);
      writeFileSync(file, JSON.stringify(status), { mode: FILE_MODE });
      // `mode` only applies on creation; tighten files written by earlier versions too.
      chmodSync(file, FILE_MODE);
      if (!pruned) {
        pruned = true;
        pruneStale();
      }
    } catch {
      // Status display is cosmetic and must never interfere with a request.
    }
  }

  /** Publish a routed prompt and retain recent exact Jev exchanges for diagnosis. */
  function writeDecision(sessionId, decision) {
    const previous = readStatus(sessionId);
    const history = [...(previous?.history ?? []), decision].slice(-20);
    writeStatus(sessionId, { ...decision, history });
  }

  /** Latest routing decision for a session, or null if none has been made yet. */
  function readStatus(sessionId) {
    try {
      return JSON.parse(readFileSync(fileFor(sessionId), "utf8"));
    } catch {
      return null;
    }
  }

  /** Delete status files untouched for `maxAgeMs`. Runs once per store on the first write. */
  function pruneStale(maxAgeMs = STALE_AFTER_MS, now = Date.now()) {
    let removed = 0;
    try {
      for (const name of readdirSync(dir)) {
        // settings.json is rewritten on every launch and must outlive long sessions.
        if (!name.endsWith(".json") || name === "settings.json") continue;
        const file = join(dir, name);
        try {
          if (now - statSync(file).mtimeMs > maxAgeMs) {
            unlinkSync(file);
            removed++;
          }
        } catch {
          // Another session may have removed or replaced it; ignore.
        }
      }
    } catch {
      // Missing or unreadable directory: nothing to prune.
    }
    return removed;
  }

  return { writeStatus, writeDecision, readStatus, pruneStale, ensurePrivateDir, STATUS_DIR: dir };
}

// The process-wide store. Every existing caller keeps the behavior it had before stores
// existed, including sharing one directory across harnesses.
const defaultStore = createStatusStore();

export const writeStatus = defaultStore.writeStatus;
export const writeDecision = defaultStore.writeDecision;
export const readStatus = defaultStore.readStatus;
export const pruneStale = defaultStore.pruneStale;
export const ensurePrivateDir = defaultStore.ensurePrivateDir;

/** Directory holding status files, exposed for tests and diagnostics. */
export const STATUS_DIR = defaultStore.STATUS_DIR;
