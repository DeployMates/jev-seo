/**
 * Parse a JSON object of environment variables out of the environment.
 *
 * A generated MCP entry without the `environment` its working counterpart
 * carries is a server that starts and then never answers: `undetected-browser`
 * comes up with no `UB_SOCKET`, so every call fails on a socket that was never
 * named. The value is the operator's to supply — the key names and values are
 * never logged, per the same rule `config.ts` follows for `.env`.
 */
function jsonEnv(raw: string | undefined): Record<string, string> | undefined {
  const trimmed = raw?.trim()
  if (!trimmed || trimmed.length === 0) return undefined
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value
    }
    return Object.keys(out).length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

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
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
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
 * Where the spawned `opencode` session runs. It needs a writable cwd and a
 * `.mcp.json` in it, because opencode resolves MCP servers from the directory it
 * is launched in. Generated rather than shipped: it points at an absolute path
 * inside this install, which differs on every machine.
 */
export function agentWorkspaceDir(): string {
  const dir = ensureDir(resolve(dataDir(), "agent"))
  writeAgentMcpConfig(dir)
  return dir
}

/** The vendored Python MCP, resolved from this install rather than from cwd. */
function mcpDir(): string {
  const override = process.env.JEV_GSC_MCP_DIR?.trim()
  if (override && override.length > 0) return resolve(override)
  return resolve(pkgRoot(), "server", "mcp", "gsc-mcp")
}

/**
 * The `open-websearch` MCP, which supplies the `open-websearch` grant its real
 * tools. It is an operator-owned server on this machine, not vendored here, so it
 * is opt-in and left absent when it is not configured — the same rule
 * `undetected-browser` follows. The prompt advertises the `open-websearch` grant
 * either way, so a run with no server behind it must degrade visibly rather than
 * teach the model to cite a tool that cannot answer.
 */
function webSearchDir(): string | null {
  const override = process.env.JEV_WEBSEARCH_MCP_DIR?.trim()
  if (!override || override.length === 0) return null
  return resolve(override)
}

/**
 * The package root, found by the `workspaces` field rather than the mere
 * presence of a `package.json` — `server/` has one of those too, and stopping
 * there made the MCP resolve to `server/server/mcp/...`.
 */
function pkgRoot(): string {
  let dir = HERE
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = resolve(dir, "package.json")
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
          workspaces?: unknown
        }
        if (Array.isArray(parsed.workspaces)) return dir
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

let agentConfigWritten = false

/**
 * The MCP servers this run may use, as the shape the opencode SDK's `Config.mcp`
 * expects. Returning the object rather than only writing `.mcp.json` is what lets
 * the SDK path hand the server list over in `OPENCODE_CONFIG_CONTENT` instead of
 * relying on the child resolving a file inside `OPENCODE_CONFIG_DIR` — the two
 * mechanisms are kept identical on purpose, so a grant cannot differ by transport.
 *
 * `gsc` is left absent when the vendored Python MCP is not on disk (it is not in
 * the published tarball): the agent then starts without Search Console tools and
 * `/api/research` degrades visibly rather than advertising a server that cannot
 * start.
 */
/**
 * The MCP servers this run may use, as the shape the opencode SDK's `Config.mcp`
 * expects. Returning the object rather than only writing `.mcp.json` is what lets
 * the SDK path hand the server list over in `OPENCODE_CONFIG_CONTENT` instead of
 * relying on the child resolving a file inside `OPENCODE_CONFIG_DIR` — the two
 * mechanisms are kept identical on purpose, so a grant cannot differ by transport.
 *
 * The two shapes are NOT the same: `.mcp.json` uses `{command, args}` while the SDK
 * types want `{type: "local", command: [...]}` with the binary as `command[0]`. A
 * server declared in the file shape and passed to the SDK is silently ignored — no
 * error, just no tools — so this is built in the SDK shape and re-shaped for the
 * file by `writeAgentMcpConfig`.
 *
 * `gsc` is left absent when the vendored Python MCP is not on disk (it is not in
 * the published tarball): the agent then starts without Search Console tools and
 * `/api/research` degrades visibly rather than advertising a server that cannot
 * start.
 */
export function agentMcpServers(): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {}

  const gsc = mcpDir()
  if (existsSync(resolve(gsc, "run.sh"))) {
    mcpServers.gsc = { type: "local", command: ["bash", resolve(gsc, "run.sh")], enabled: true }
  }

  const webSearch = webSearchDir()
  if (webSearch && existsSync(resolve(webSearch, "build", "index.js"))) {
    mcpServers["open-websearch"] = {
      type: "local",
      command: ["node", resolve(webSearch, "build", "index.js")],
      enabled: true,
      // It defaults to `BOTH`, which binds an HTTP listener on :3000 before it ever
      // reaches the stdio transport. Anything already on that port — a stray
      // dev server on this machine is enough — makes it exit with EADDRINUSE, and
      // an MCP server that dies at startup registers no tools at all, so the run
      // degrades with no error naming the cause. stdio is the only mode a client
      // spawning it can use.
      environment: { MODE: "stdio" },
    }
  }

  // `undetected-browser` is a real MCP owned by the operator, so it is opt-in via
  // an explicit command rather than by reading their global config — the child
  // must never inherit anything it was not handed.
  const ubCmd = process.env.JEV_UNDETECTED_BROWSER_CMD?.trim()
  if (ubCmd) {
    mcpServers["undetected-browser"] = {
      type: "local",
      command: ["sh", "-c", ubCmd],
      enabled: true,
      environment: jsonEnv(process.env.JEV_UNDETECTED_BROWSER_ENV),
    }
  }

  return mcpServers
}

/** The same list in `.mcp.json`'s `{command, args}` shape, for the CLI transport. */
function agentMcpServersForFile(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(agentMcpServers())) {
    const s = spec as { command?: unknown; environment?: unknown }
    const argv = Array.isArray(s.command) ? (s.command as string[]) : []
    const [bin, ...args] = argv
    if (!bin) continue
    out[name] = { command: bin, args, enabled: true, environment: s.environment }
  }
  return out
}

function writeAgentMcpConfig(dir: string): void {
  if (agentConfigWritten) return

  const mcpServers = agentMcpServersForFile()

  try {
    // Anti-pattern 13: the child's only readable opencode config. Pointing
    // `OPENCODE_CONFIG_DIR` here is what stops it resolving the operator's global
    // `~/.config/opencode/opencode.json`.
    writeBaselinePermissions(dir)

    if (Object.keys(mcpServers).length > 0) {
      writeFileSync(
        resolve(dir, ".mcp.json"),
        `${JSON.stringify({ $schema: "https://opencode.ai/config.json", mcpServers }, null, 2)}\n`,
        "utf8",
      )
    }
    agentConfigWritten = true
  } catch {
    /* a read-only data dir is reported by probeWritable at boot */
  }
}

/**
 * The permissions the spawned session runs under, rewritten before every run.
 *
 * It cannot be a module constant. The one path the agent is allowed to write is
 * `outputPath`, which `runResearch` picks at call time
 * (`research/run-<ts>-<pid>.json`) and hands to the prompt as an absolute path.
 * A glob written at import time does not match it, so the agent is told to write
 * a file it is then denied — which fails gate 1 on every run.
 *
 * Three things this block deliberately does *not* do:
 *
 * - **It does not deny `webfetch`.** `NAME_PATTERNS["open-websearch"]`
 *   (`agent.ts:108`) folds opencode's `websearch` *and* `webfetch` builtins onto
 *   one bucket, and the prompt advertises that bucket as granted. Denying
 *   `webfetch` therefore denies the only competitor/keyword data source the
 *   agent has, while the prompt still tells it to call one — the exact
 *   `unsourced-number` failure `docs/LAYERS.md` describes. `websearch` is named
 *   explicitly too: it is a separate permission key that merely happens to
 *   default to `allow`, and a research run must not depend on a default.
 * - **It does not grant `write` as its own key.** opencode has no `write`
 *   permission. `edit` is the single file-writing action and it covers `edit`,
 *   `write`, `patch` and `apply_patch` alike, so scoping `edit` to one absolute
 *   path grants every write verb for that file and no other. Adding a `write`
 *   key here would be a typo that reads as a grant and grants nothing.
 * - **It does not leave `external_directory` denied.** `outputPath` lives in
 *   `logs/research/`, outside the workspace the child runs in, and opencode
 *   checks `external_directory` *before* the tool's own `read`/`edit` decision.
 *   Denying it blocks the one write this run exists to perform.
 */
export function writeAgentPermissions(outputPath: string): void {
  const dir = ensureDir(resolve(dataDir(), "agent"))
  const permission = agentPermission(outputPath)

  try {
    writeFileSync(
      resolve(dir, "opencode.json"),
      `${JSON.stringify({ $schema: "https://opencode.ai/config.json", permission }, null, 2)}\n`,
      "utf8",
    )
    agentConfigWritten = true
  } catch {
    /* a read-only data dir is reported by probeWritable at boot */
  }
}

/**
 * The permission block for one run, as a value. Both transports consume this
 * exact object — the CLI path writes it to `opencode.json`, the SDK path hands it
 * over in `OPENCODE_CONFIG_CONTENT` — so a grant cannot differ by how the run was
 * launched.
 */
export function agentPermission(outputPath: string): Record<string, unknown> {
  const target = resolve(outputPath)
  // The boundary the write lives inside, granted as a directory so the `edit`
  // rule below stays the thing that actually narrows it to one file.
  const outputDir = `${dirname(target)}/**`

  return {
    bash: "deny",
    webfetch: "allow",
    websearch: "allow",
    edit: { "*": "deny", [target]: "allow" } as Record<string, string>,
    external_directory: { "*": "deny", [outputDir]: "allow" } as Record<string, string>,
    doom_loop: "deny",
  }
}

/**
 * The baseline, written when the workspace is created so the child is never
 * briefly running on opencode's permissive defaults. It permits no write at all;
 * `writeAgentPermissions` is what opens the single output path, and it is called
 * on every run before the process is spawned.
 */
function writeBaselinePermissions(dir: string): void {
  const permission = {
    bash: "deny",
    webfetch: "allow",
    websearch: "allow",
    edit: "deny",
    external_directory: "deny",
    doom_loop: "deny",
  }
  writeFileSync(
    resolve(dir, "opencode.json"),
    `${JSON.stringify({ $schema: "https://opencode.ai/config.json", permission }, null, 2)}\n`,
    "utf8",
  )
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
