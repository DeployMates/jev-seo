/**
 * Proxy pool rotation.
 *
 * `proxies.txt` is a local-only file, one `IP:PORT:USER:PASS` per line, with
 * `#` comments. Blank lines and malformed lines are skipped rather than thrown
 * on, because a pool that has drifted out of date must not take the audit down
 * with it — a bad line means one fewer proxy, not a broken run.
 *
 * The rotator hands out one proxy per request and remembers the last N it used
 * so it can skip a proxy that just failed. Rotation is round-robin, not random:
 * a deterministic order is easier to reason about when a run misbehaves.
 *
 * Nothing here is allowed to leak credentials into a log line or an error
 * message. `redact()` is the only way a proxy is ever rendered as a string.
 */
import { existsSync, readFileSync } from "node:fs"
import { proxiesPath } from "./paths.js"

export interface Proxy {
  /** `IP:PORT`, the host half of the line. */
  readonly endpoint: string
  readonly host: string
  readonly port: number
  readonly username: string
  readonly password: string
  /** Ready to hand to an HTTP client: `http://user:pass@ip:port`. */
  readonly url: string
}

export interface ProxyParseResult {
  readonly proxies: readonly Proxy[]
  /** Line numbers (1-based) that were blank, commented or malformed. */
  readonly skipped: readonly number[]
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
const HOSTNAME = /^[a-zA-Z0-9.-]+$/

/**
 * One line of `proxies.txt` into a `Proxy`. Returns `null` for anything that is
 * not a well-formed `IP:PORT:USER:PASS` entry — callers count those as skipped
 * instead of aborting.
 */
export function parseProxyLine(rawLine: string): Proxy | null {
  const line = rawLine.trim()
  if (line.length === 0 || line.startsWith("#")) return null

  // The password is the last field, and a password may itself contain a colon.
  // So split from the left three times and let the tail hold everything else.
  const parts = line.split(":")
  if (parts.length < 4) return null
  const [host, portRaw, username, ...passwordParts] = parts as [string, string, string, ...string[]]
  const password = passwordParts.join(":")
  if (password.length === 0) return null
  if (username.length === 0) return null

  const isHost = IPV4.test(host) || HOSTNAME.test(host)
  if (!isHost) return null

  const port = Number(portRaw)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null

  const credentials = `${encodeURIComponent(username)}:${encodeURIComponent(password)}`
  return {
    endpoint: `${host}:${port}`,
    host,
    port,
    username,
    password,
    url: `http://${credentials}@${host}:${port}`,
  }
}

/** Read a whole `proxies.txt` into proxies plus the lines that were skipped. */
export function parseProxiesFile(contents: string): ProxyParseResult {
  const proxies: Proxy[] = []
  const skipped: number[] = []
  const lines = contents.split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseProxyLine(lines[index] ?? "")
    if (parsed) proxies.push(parsed)
    else if ((lines[index] ?? "").trim().length > 0) skipped.push(index + 1)
  }

  return { proxies, skipped }
}

/**
 * Where `proxies.txt` is looked for, in order: `JEV_PROXIES_FILE`, the data
 * directory, then the cwd. See `paths.ts` — the last step is what keeps the
 * repo workflow (a `proxies.txt` in the project root) working unchanged.
 *
 * The old implementation walked up looking for a `server/package.json` marker.
 * That found the repo root in a checkout and nothing inside a packed tarball,
 * so a packaged install silently ran with an empty proxy pool.
 *
 * Null means "never configured", which is not an error: the rotator runs direct.
 */
export function defaultProxiesPath(): string | null {
  return proxiesPath()
}

/** `user:pass@1.2.3.4:8080` — the endpoint stays, the credentials do not. */
export function redact(proxy: Proxy): string {
  return `<proxy ${proxy.endpoint}>`
}

/**
 * Round-robin pool that remembers recently failed proxies and steps over them.
 * A failure is a soft signal: the proxy is parked for `cooldownMs` rather than
 * dropped, because a proxy that timed out may be fine on the next run.
 */
export class ProxyRotator {
  private readonly pool: readonly Proxy[]
  private readonly cooldownMs: number
  private cursor = 0
  private readonly parkedUntil = new Map<string, number>()

  private constructor(pool: readonly Proxy[], cooldownMs: number) {
    this.pool = pool
    this.cooldownMs = cooldownMs
  }

  /**
   * Build from a `proxies.txt` path. A missing file is not an error — it means
   * the pool was never configured, and the caller runs direct. A null path is
   * the same case: nothing was ever configured, anywhere.
   */
  static fromFile(path: string | null = defaultProxiesPath(), cooldownMs = 60_000): ProxyRotator {
    if (!path) return ProxyRotator.empty(cooldownMs)
    if (!existsSync(path)) return ProxyRotator.empty(cooldownMs)
    return ProxyRotator.fromText(readFileSync(path, "utf8"), cooldownMs)
  }

  static fromText(contents: string, cooldownMs = 60_000): ProxyRotator {
    const { proxies } = parseProxiesFile(contents)
    return new ProxyRotator(proxies, cooldownMs)
  }

  static empty(cooldownMs = 60_000): ProxyRotator {
    return new ProxyRotator([], cooldownMs)
  }

  get size(): number {
    return this.pool.length
  }

  isEmpty(): boolean {
    return this.pool.length === 0
  }

  /** The next usable proxy, or `null` when the pool is empty or fully parked. */
  next(): Proxy | null {
    if (this.pool.length === 0) return null
    const now = Date.now()

    for (let attempt = 0; attempt < this.pool.length; attempt += 1) {
      const proxy = this.pool[this.cursor % this.pool.length]
      this.cursor = (this.cursor + 1) % this.pool.length
      if (!proxy) continue

      const parkedUntil = this.parkedUntil.get(proxy.endpoint) ?? 0
      if (parkedUntil > now) continue

      this.parkedUntil.delete(proxy.endpoint)
      return proxy
    }

    // Every proxy is parked. Fall back to the one whose cooldown expires
    // soonest rather than reporting an empty pool — stale beats nothing.
    let soonest: Proxy | null = null
    let soonestAt = Number.POSITIVE_INFINITY
    for (const proxy of this.pool) {
      const parkedUntil = this.parkedUntil.get(proxy.endpoint) ?? 0
      if (parkedUntil < soonestAt) {
        soonest = proxy
        soonestAt = parkedUntil
      }
    }
    return soonest
  }

  /** Park a proxy for the cooldown window. Unknown endpoints are ignored. */
  fail(proxy: Proxy, cooldownMs = this.cooldownMs): void {
    if (!this.pool.some((candidate) => candidate.endpoint === proxy.endpoint)) return
    this.parkedUntil.set(proxy.endpoint, Date.now() + cooldownMs)
  }

  /** Put a proxy back in rotation immediately. */
  succeed(proxy: Proxy): void {
    this.parkedUntil.delete(proxy.endpoint)
  }

  /** Endpoints currently parked, with the ms left on each. For diagnostics. */
  parked(): Array<{ endpoint: string; retryInMs: number }> {
    const now = Date.now()
    const out: Array<{ endpoint: string; retryInMs: number }> = []
    for (const [endpoint, until] of this.parkedUntil) {
      if (until > now) out.push({ endpoint, retryInMs: until - now })
    }
    return out
  }
}
