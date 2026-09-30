import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { ProxyAgent, type Dispatcher } from "undici"

const DEFAULT_POOL = join(homedir(), ".config/opencode/plugins/proxies.txt")
const COOLDOWN_MS = 15 * 60 * 1000

interface Upstream {
  url: string
  host: string
  blockedUntil: number
}

let pool: Upstream[] = []
let cursor = 0
let loaded = false
let warned = false

function loadPool(): void {
  const path = process.env.JEV_PROXY_POOL ?? DEFAULT_POOL
  try {
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.split("|")[0]!.trim())
      .filter(Boolean)
    pool = lines
      .map((line) => {
        // `host:port:user:pass` (Webshare) or bare `host:port` (public free
        // proxies carry no credentials). A free pool with no auth is the whole
        // point when the paid one is out of bandwidth — rejecting it silently
        // left the pool empty and every request fell through to direct, which
        // is how a working proxy ends up looking like a dead one.
        const parts = line.split(":")
        const [host, port, user, pass] = parts
        if (!host || !port) return null
        const auth = user && pass ? `${user}:${pass}@` : ""
        return { url: `http://${auth}${host}:${port}`, host, blockedUntil: 0 }
      })
      .filter((u): u is Upstream => u !== null)
    loaded = true
  } catch {
    pool = []
    loaded = true
  }
}

/**
 * The keyless `public` credential is metered per egress IP, so a spent IP is
 * the only thing standing between a run and a working judge. Rotating to a
 * different residential address is what clears it; retrying the same one never
 * will, which is why a 429 rotates the cursor instead of only backing off.
 */
function available(): Upstream[] {
  const now = Date.now()
  return pool.filter((u) => u.blockedUntil <= now)
}

export function proxyEnabled(): boolean {
  if (!loaded) loadPool()
  if (process.env.JEV_NO_PROXY === "1") return false
  return available().length > 0
}

/** The upstream this request should egress from, or undefined to go direct. */
export function currentUpstream(): Upstream | undefined {
  if (!loaded) loadPool()
  if (process.env.JEV_NO_PROXY === "1") return undefined
  const live = available()
  if (live.length === 0) {
    if (!warned && pool.length > 0) {
      warned = true
      console.warn("[jev-seo] every proxy in the pool is cooling down — going direct")
    }
    return undefined
  }
  return live[cursor % live.length]
}

export function dispatcherFor(upstream: Upstream | undefined): Dispatcher | undefined {
  if (!upstream) return undefined
  return new ProxyAgent(upstream.url)
}

/**
 * Quarantine the IP that just answered 429 and step the cursor on. Returns the
 * next upstream so the caller can retry the same request immediately.
 */
export function rotateAfterQuota(current: Upstream | undefined): Upstream | undefined {
  if (current) current.blockedUntil = Date.now() + COOLDOWN_MS
  cursor += 1
  if (available().length === 0) {
    cursor = 0
    return undefined
  }
  return available()[cursor % available().length]
}

/**
 * Park a proxy that failed at the transport layer — 402 from a provider out of
 * credit, dead host, tunnel that never opened.
 *
 * Quarantine used to be quota-only, which made a stale pool actively harmful: a
 * dead entry was never parked, so every retry returned to the same broken
 * upstream and the run died with N identical `fetch failed` errors instead of
 * stepping to the next working address. A transport failure says as much about
 * the address as a 429 does, so it earns the same cooldown. Named separately so
 * the two reasons stay distinguishable at the call site.
 */
export function rotateAfterTransportFailure(current: Upstream | undefined): Upstream | undefined {
  return rotateAfterQuota(current)
}

export function proxyStatus(): { pool: number; live: number; host: string | null } {
  if (!loaded) loadPool()
  const up = currentUpstream()
  return { pool: pool.length, live: available().length, host: up?.host ?? null }
}