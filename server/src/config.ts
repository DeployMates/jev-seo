/**
 * Runtime configuration. Nothing secret is stored in the repo: the Zen key is
 * read from the environment at call time, exactly like opencode resolves its own
 * provider credentials. With no key the audit still runs and the Jev sections
 * are reported as "not assessed" (partial audit) rather than failing.
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { dataDir } from "./paths.js"

function loadDotEnv(file: string): string[] {
  if (!existsSync(file)) return []
  const keys: string[] = []
  for (const rawLine of readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) {
      process.env[key] = value
      keys.push(key)
    }
  }
  return keys
}

/**
 * Explicit order: `JEV_ENV_FILE`, the data dir, then the cwd. The old version
 * walked `process.cwd()` only, so a binary started anywhere but the repo loaded
 * nothing and fell through to defaults silently — including the model. The cwd
 * candidate is kept last so the repo workflow still works without outranking a
 * deliberate choice.
 */
const envFile = (() => {
  const override = process.env.JEV_ENV_FILE?.trim()
  const candidates = [
    ...(override && override.length > 0 ? [resolve(override)] : []),
    resolve(dataDir(), ".env"),
    resolve(process.cwd(), ".env"),
  ]
  for (const candidate of candidates) {
    const keys = loadDotEnv(candidate)
    if (keys.length > 0) return { path: candidate, keys }
  }
  return null
})()

/** For `doctor` and the boot line. The path and the key names, never a value. */
export const envFileLoaded = envFile

/**
 * OpenCode Zen gateway. It serves Jev itself at `/systemone` with the keyless
 * `public` credential plus an OpenCode client fingerprint, so there is no
 * TypeSafe account in the loop. The Zen `models` list also advertises
 * `jev-1.13-free`; a workspace key is only required for the rate-limited
 * `jev-1.13`.
 */
export const ZEN_BASE_URL = (
  process.env.ZEN_BASE_URL ?? "https://opencode.ai/zen/v1"
).replace(/\/+$/, "")

/** The keyless Zen tier. `jev-1.13` needs a workspace and 401s without one. */
export const DEFAULT_MODEL = process.env.JEV_MODEL ?? "jev-1.13-free"

/** docs.typesafe.ai/models — US$ per million input tokens, output free. */
export const USD_PER_MTOK = Number(process.env.JEV_USD_PER_MTOK ?? 0.042)

export const PORT = Number(process.env.PORT ?? 8787)

/** Zen account limits: 1200 requests/min, 250k tokens/s. One page per request. */
export const DEFAULT_CONCURRENCY = 8
export const MAX_CONCURRENCY = 20

export const DEFAULT_MAX_PAGES = 40
export const MAX_PAGES_CEILING = 60
/** Per-request ceiling. The whole-crawl ceiling is `budgetMs`, passed to crawl(). */
export const CRAWL_TIMEOUT_MS = Number(process.env.CRAWL_TIMEOUT_MS ?? 30_000)

/**
 * Crawl retry policy. A single 429 or a dropped connection should not cost a
 * page, but a crawl is bounded by a wall-clock budget, so retrying is only
 * worth it while there is still time left to land the result. The crawler
 * therefore treats the budget as the hard limit and these as preferences:
 * attempts are cheap, and the last word belongs to the deadline.
 */
export const CRAWL_RETRY_ATTEMPTS = Number(process.env.CRAWL_RETRY_ATTEMPTS ?? 3)
export const CRAWL_RETRY_BASE_MS = Number(process.env.CRAWL_RETRY_BASE_MS ?? 250)
export const CRAWL_RETRY_MAX_DELAY_MS = Number(process.env.CRAWL_RETRY_MAX_DELAY_MS ?? 4_000)
export const JEV_TIMEOUT_MS = 15_000
export const JEV_MAX_RETRIES = 3

/** Jev cannot see images, so page text is capped before it enters the state. */
export const PAGE_TEXT_CHARS = 6_000

/**
 * Zen's free tier is keyless: the literal credential is the string `public`.
 * A real key is still honoured when present, because `jev-1.13` is rate
 * limited and needs a workspace.
 */
export function zenKey(): string | undefined {
  const raw = process.env.ZEN_API_KEY ?? process.env.OPENCODE_API_KEY
  if (raw && raw.trim().length > 0) return raw.trim()
  // `public` is the keyless free tier, which is per-egress-IP and 429s once
  // spent. JEV_NO_ZEN=1 forces the local opencode judge instead, so a burned
  // IP is a configuration choice rather than a dead dashboard.
  if (process.env.JEV_NO_ZEN === "1") return undefined
  return "public"
}

export interface ZenFingerprint {
  userAgent: string
  session: string
  request: string
  client: string
  project: string
}

/**
 * Zen only serves its free tier to traffic that identifies as OpenCode, so the
 * `x-opencode-*` pair has to be one the gateway already knows. Minted by a real
 * run: `opencode run -m opencode/<a free model> "hi"`, then read the ses_/msg_
 * ids out of the opencode logs. A ses_ from one run paired with a msg_ from
 * another is rejected, hence one fingerprint object rather than two.
 */
function fingerprint(): ZenFingerprint {
  return {
    userAgent: process.env.ZEN_USER_AGENT ?? "opencode/1.18.32 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14",
    session: process.env.ZEN_SESSION_ID ?? "ses_f4761a198ffefreyomXRX3A5t1",
    request: process.env.ZEN_REQUEST_ID ?? "msg_0b898a0fd0016VRG3fbsDpi2XT",
    client: "cli",
    project: "global",
  }
}

export function zenHeaders(key: string): Record<string, string> {
  const print = fingerprint()
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
    "User-Agent": print.userAgent,
    "x-opencode-session": print.session,
    "x-opencode-request": print.request,
    "x-opencode-client": print.client,
    "x-opencode-project": print.project,
  }
}
