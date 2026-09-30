/**
 * Every filesystem location the server touches, in one place.
 *
 * The rule this module exists to enforce: **the install directory is
 * read-only.** Nothing is ever written next to the code.
 *
 * That rule is not a style preference. Under `npx` the package lives in
 * `~/.npm/_npx/<hash>/node_modules/jev-seo`, and npm garbage-collects that
 * directory whenever it likes — a `.gsc/service-account.json` (a private key)
 * or a research transcript written there is gone, silently, with no error. Under
 * a global install the same write can hit a root-owned path and throw EACCES
 * four minutes into a session.
 *
 * So: everything mutable lives under one directory, resolved once, never
 * derived from the install location.
 *
 *   JEV_DATA_DIR   explicit override, honoured everywhere
 *   ~/.jev-seo     the default
 *
 * `JEV_REPO_ROOT` is deliberately gone. It existed only to paper over the
 * repo-vs-install ambiguity and it was wrong in both worlds: inside a packed
 * tarball the `server/package.json` marker walk found nothing, and inside
 * `node_modules` it found the wrong thing.
 */
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

/** The default state directory. `~` is resolved, never passed through literally. */
function defaultDataDir(): string {
  return resolve(homedir(), ".jev-seo")
}

/**
 * The one writable root. Memoised so every call in a process agrees, and so an
 * invalid `JEV_DATA_DIR` is reported once rather than per module.
 */
let cached: string | null = null

export function dataDir(): string {
  if (cached) return cached
  const override = process.env.JEV_DATA_DIR?.trim()
  cached = override && override.length > 0 ? resolve(override) : defaultDataDir()
  return cached
}

/** Test seam: forget the memoised root after the environment changes. */
export function resetDataDirCache(): void {
  cached = null
}

function ensureDir(path: string, mode?: number): string {
  mkdirSync(path, { recursive: true, ...(mode !== undefined ? { mode } : {}) })
  return path
}

/* -------------------------------------------------------------------------- */
/* secrets                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The GSC service account, at a fixed server-owned path. The filename is fixed
 * and no request-supplied path is ever honoured — that invariant is a security
 * boundary, not a convenience, and it lives here now.
 *
 * Mode 0700 on the directory and 0600 on the file: it holds a private key.
 */
export function gscDir(): string {
  return ensureDir(resolve(dataDir(), ".gsc"), 0o700)
}

export function gscKeyPath(): string {
  return resolve(gscDir(), "service-account.json")
}

/* -------------------------------------------------------------------------- */
/* runtime state                                                              */
/* -------------------------------------------------------------------------- */

export function logsDir(): string {
  return ensureDir(resolve(dataDir(), "logs"))
}

export function researchDir(): string {
  return ensureDir(resolve(logsDir(), "research"))
}

/**
 * One file per audited root, holding the last N run snapshots.
 *
 * The filename is a truncated SHA-256 of the root's origin, never the host
 * itself: a host is request-controlled, and the same rule `gscKeyPath` follows —
 * a fixed, server-owned location, never a path built out of a request. The
 * un-hashed root is written inside the file, so a collision is visible instead
 * of silently merging two sites' history.
 */
export function historyPath(origin: string): string {
  const key = createHash("sha256").update(origin).digest("hex").slice(0, 32)
  return resolve(historyDir(), `${key}.json`)
}

export function historyDir(): string {
  return ensureDir(resolve(dataDir(), "history"), 0o700)
}

export function serverLogPath(): string {
  return resolve(logsDir(), "server.log")
}

/** PID file for `jev-seo start --detach` / `stop`. The reason `stop` is safe. */
export function pidFilePath(): string {
  return resolve(dataDir(), "jev-seo.pid")
}

/**
 * Where the spawned `opencode` session runs. It needs a writable cwd of its own,
 * and a `.mcp.json` if the optional GSC MCP is going to be registered for it.
 */
export function agentWorkspaceDir(): string {
  return ensureDir(resolve(dataDir(), "agent"))
}

/* -------------------------------------------------------------------------- */
/* proxies                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Resolution order: explicit override, then the data dir, then the cwd. The
 * last one is not an accident — it is what keeps the existing repo workflow
 * (a `proxies.txt` sitting in the project root) working unchanged.
 *
 * A missing file is never an error. It means the pool was never configured and
 * the crawler runs direct.
 */
export function proxiesPath(): string | null {
  const override = process.env.JEV_PROXIES_FILE?.trim()
  if (override && override.length > 0) return resolve(override)

  const inData = resolve(dataDir(), "proxies.txt")
  if (existsSync(inData)) return inData

  const inCwd = resolve(process.cwd(), "proxies.txt")
  if (existsSync(inCwd)) return inCwd

  return null
}

/* -------------------------------------------------------------------------- */
/* the built web UI                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Where `web/dist` is, in a repo checkout and in a packed tarball.
 *
 * This is the one path that legitimately differs between the two, because it
 * points at read-only shipped assets rather than at mutable state. So it is
 * resolved by *looking for the build output* rather than by assuming a layout:
 * the marker is `web/dist/index.html`, which exists in a checkout and in the
 * tarball, and exists nowhere else.
 *
 * Returns null when the UI has not been built. The caller must fail loudly
 * rather than serve a bare API, because an API with no UI is indistinguishable
 * from a broken install.
 */
export function webDist(): string | null {
  const override = process.env.JEV_WEB_DIST?.trim()
  if (override && override.length > 0) {
    return existsSync(resolve(override, "index.html")) ? resolve(override) : null
  }

  let dir = HERE
  // 8 levels is far past any real layout; the loop is bounded so a symlink loop
  // cannot hang the boot.
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = resolve(dir, "web", "dist")
    if (existsSync(resolve(candidate, "index.html"))) return candidate

    // Also handle a layout where this module is nested one level deeper
    // (`server/dist/paths.js`), which is the shape the build actually produces.
    const sibling = resolve(dir, "..", "web", "dist")
    if (existsSync(resolve(sibling, "index.html"))) return sibling

    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return null
}

/* -------------------------------------------------------------------------- */
/* writability                                                                */
/* -------------------------------------------------------------------------- */

export interface Writability {
  readonly ok: boolean
  readonly path: string
  readonly error?: string
}

/**
 * Prove the data directory is writable *now*, at boot, rather than letting the
 * first GSC upload fail four minutes into a session. The probe is a real
 * write-then-delete: `access()` lies on network mounts and under sudo, and only
 * an actual write tells the truth.
 */
export function probeWritable(dir: string = dataDir()): Writability {
  const probe = resolve(dir, ".probe")
  try {
    ensureDir(dir)
    writeFileSync(probe, "", { encoding: "utf8" })
    rmSync(probe, { force: true })
    return { ok: true, path: dir }
  } catch (error) {
    return { ok: false, path: dir, error: (error as Error).message }
  }
}
