/**
 * Search Console onboarding.
 *
 * GSC is hard-walled by Google. On a site this account does not own the API
 * answers `403 — User does not have sufficient permission`, so the dashboard
 * must never *assume* access. Everything here reports what was actually proven:
 * `listProperties()` asks Google which properties this key can see, and
 * `status()` compares the target URL against that answer. No heuristic, no
 * optimism.
 *
 * Two invariants this module holds without exception:
 *
 *  1. The uploaded JSON is validated strictly and written to a path the server
 *     owns — `<repo>/.gsc/service-account.json`, mode 0600. A path from the
 *     request body is never used, so a hostile upload cannot traverse out of
 *     the directory. The filename is fixed.
 *  2. `private_key` never leaves this module. It is not in any return type, not
 *     in any error message, and not in any log line. `GscPublicInfo` is the
 *     only shape that crosses the boundary.
 *
 * Token minting is RS256 over the service account's own key using `node:crypto`
 * — no Google client library, no extra dependency, nothing to install for an
 * onboarding check to pass.
 */
import { createPrivateKey, createSign } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { gscKeyPath } from "./paths.js"

const TOKEN_URL = "https://oauth2.googleapis.com/token"
const SEARCH_CONSOLE_BASE = "https://searchconsole.googleapis.com/webmasters/v3"
const JWT_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer"

/**
 * Owner, not Full: the Indexing API refuses anything less, so a Full grant
 * would onboard as a success and then fail on the first write.
 */
const SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/webmasters",
  "https://www.googleapis.com/auth/indexing",
]

const PRIVATE_KEY_HEADER = "-----BEGIN PRIVATE KEY-----"
const REQUEST_TIMEOUT_MS = 15_000
const TOKEN_LIFETIME_S = 3600

export type GscPermission = "siteOwner" | "siteFullUser" | "siteRestrictedUser" | "unverified"

export interface GscProperty {
  /** `sc-domain:example.com` or `https://example.com/` — Google's own form. */
  readonly siteUrl: string
  readonly permissionLevel: GscPermission
}

export interface GscPublicInfo {
  readonly clientEmail: string
  readonly projectId: string | null
  readonly privateKeyId: string | null
}

/** Everything a caller gets back. Deliberately no `private_key` field. */
export interface ConnectResult {
  readonly connected: boolean
  readonly clientEmail: string
  readonly properties: readonly GscProperty[]
  readonly error?: string
}

export interface GscStatus {
  readonly configured: boolean
  readonly verified: boolean
  /** The Google site key we looked up, e.g. `sc-domain:example.com`. */
  readonly siteUrl: string | null
  readonly permissionLevel: GscPermission | null
  readonly clientEmail: string | null
  readonly error?: string
}

export class GscValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GscValidationError"
  }
}

export class GscAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GscAuthError"
  }
}

/**
 * Fixed, server-owned location. Never derived from a request.
 *
 * Resolved through `paths.ts` rather than by walking up to a repo root: the key
 * is user state, so it belongs in the data directory. A repo-root walk found
 * the right place in a checkout and nothing at all inside a packed tarball,
 * which is how onboarding reported a connection no tool could use.
 */
export function serviceAccountPath(): string {
  return gscKeyPath()
}

/**
 * True only when a service account is present *and* its key loads.
 *
 * Existence alone is not configuration: a placeholder passes `parseServiceAccount`
 * (right PEM markers) and then fails at the first signature, so a "configured"
 * dashboard would claim Search Console access it lacks. `createPrivateKey` is
 * local and offline, so the check costs nothing on the status path.
 */
export function isConfigured(): boolean {
  const stored = readJson(serviceAccountPath())
  if (!isRecord(stored)) return false

  let account: Record<string, unknown>
  try {
    account = parseServiceAccount(stored)
  } catch {
    return false
  }

  const privateKey = account["private_key"]
  if (typeof privateKey !== "string") return false
  try {
    createPrivateKey(privateKey)
    return true
  } catch {
    return false
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function normalisePem(value: string): string {
  // A key pasted out of a terminal keeps its newlines escaped. Restore them
  // before handing the PEM to OpenSSL, or the signature silently fails.
  return value.replace(/\\n/g, "\n").trim()
}

/**
 * Accept the upload as an object, a JSON string, or a Buffer and return the
 * validated service account. Throws `GscValidationError` with a message meant
 * for the person who dropped the file, not for a log.
 */
export function parseServiceAccount(input: unknown): Record<string, unknown> {
  let candidate: unknown = input

  if (Buffer.isBuffer(candidate)) candidate = candidate.toString("utf8")
  if (typeof candidate === "string") {
    const trimmed = candidate.trim()
    if (trimmed.length === 0) throw new GscValidationError("The file is empty.")
    try {
      candidate = JSON.parse(trimmed) as unknown
    } catch {
      throw new GscValidationError("That file is not valid JSON.")
    }
  }

  if (!isRecord(candidate)) {
    throw new GscValidationError("Expected a service account JSON object.")
  }
  if (candidate["type"] !== "service_account") {
    throw new GscValidationError(
      'Expected type "service_account". That file is a different kind of Google credential.',
    )
  }
  if (!nonEmptyString(candidate["client_email"])) {
    throw new GscValidationError("Missing client_email.")
  }
  if (!nonEmptyString(candidate["project_id"])) {
    throw new GscValidationError("Missing project_id.")
  }

  const privateKey = candidate["private_key"]
  if (!nonEmptyString(privateKey)) {
    throw new GscValidationError("Missing private_key.")
  }
  const pem = normalisePem(privateKey)
  if (!pem.startsWith(PRIVATE_KEY_HEADER)) {
    throw new GscValidationError('private_key must begin with "-----BEGIN PRIVATE KEY-----".')
  }
  if (!pem.includes("-----END PRIVATE KEY-----")) {
    throw new GscValidationError("private_key is truncated — the end marker is missing.")
  }

  // Normalise in place so downstream code never has to think about `\n` escapes.
  return { ...candidate, private_key: pem }
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, key: string): string {
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const signer = createSign("RSA-SHA256")
  signer.update(signingInput)
  const signature = signer.sign(key, "base64url")
  return `${signingInput}.${signature}`
}

interface CachedToken {
  readonly token: string
  readonly expiresAt: number
}

let cachedToken: CachedToken | null = null

/** Drop the memoised token. Called when a new service account is written. */
export function resetTokenCache(): void {
  cachedToken = null
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Exchange the service account key for a short-lived access token. Cached until
 * a minute before expiry, because a token is valid for an hour and an
 * onboarding check should not mint one per call.
 */
async function accessToken(account: Record<string, unknown>): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token

  const clientEmail = account["client_email"]
  const privateKey = account["private_key"]
  if (typeof clientEmail !== "string" || typeof privateKey !== "string") {
    throw new GscAuthError("The stored service account is missing client_email or private_key.")
  }

  const now = Math.floor(Date.now() / 1000)

  let assertion: string
  try {
    assertion = signJwt(
      { alg: "RS256", typ: "JWT" },
      {
        iss: clientEmail,
        scope: SCOPES.join(" "),
        aud: TOKEN_URL,
        iat: now,
        exp: now + TOKEN_LIFETIME_S,
      },
      privateKey,
    )
  } catch {
    // A bare catch looks like a swallow, so: the OpenSSL diagnostic is dropped
    // deliberately because its wording varies by version and it is built from
    // the key we are handling. Nothing from it reaches the caller.
    throw new GscAuthError(
      "The private_key in that service account could not be read. Re-download the JSON key from Google Cloud.",
    )
  }

  let response: Response
  try {
    response = await fetchWithTimeout(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: JWT_GRANT_TYPE,
        assertion,
      }).toString(),
    })
  } catch (error) {
    // The body above carried the assertion, not the key, but the error is
    // reported verbatim only if it cannot carry credentials — and a fetch
    // failure never does.
    throw new GscAuthError(`Could not reach Google to exchange the key: ${String(error)}`)
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300)
    throw new GscAuthError(`Google rejected the service account key (${response.status}): ${detail}`)
  }

  const body = (await response.json()) as Record<string, unknown>
  const token = body["access_token"]
  if (!nonEmptyString(token)) {
    throw new GscAuthError("Google returned no access token for this service account.")
  }

  const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : TOKEN_LIFETIME_S
  cachedToken = { token, expiresAt: Date.now() + expiresIn * 1000 }
  return token
}

/** The part of a service account that is safe to hand to a browser. */
export function toPublicInfo(account: Record<string, unknown>): GscPublicInfo {
  return {
    clientEmail: String(account["client_email"] ?? ""),
    projectId: nonEmptyString(account["project_id"]) ? account["project_id"] : null,
    privateKeyId: nonEmptyString(account["private_key_id"]) ? account["private_key_id"] : null,
  }
}

function isPermission(value: unknown): value is GscPermission {
  return (
    value === "siteOwner" ||
    value === "siteFullUser" ||
    value === "siteRestrictedUser" ||
    value === "unverified"
  )
}

/**
 * Every property this service account can see. This is the single source of
 * truth for access — nothing is inferred from the URL the user typed.
 */
export async function listProperties(): Promise<GscProperty[]> {
  const path = serviceAccountPath()
  if (!existsSync(path)) {
    throw new GscAuthError("No Search Console service account is connected on this machine.")
  }

  const stored = readJson(path)
  if (!isRecord(stored)) {
    throw new GscAuthError("The stored service account is not valid JSON. Reconnect Search Console.")
  }
  const account = parseServiceAccount(stored)
  const token = await accessToken(account)

  let response: Response
  try {
    response = await fetchWithTimeout(`${SEARCH_CONSOLE_BASE}/sites`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch (error) {
    throw new GscAuthError(`Could not reach Search Console: ${String(error)}`)
  }

  if (response.status === 403) {
    throw new GscAuthError(
      "Search Console denied this key. Grant the service account Owner access on the property.",
    )
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300)
    throw new GscAuthError(`Search Console returned ${response.status}: ${detail}`)
  }

  const body = (await response.json()) as { siteEntry?: unknown }
  const entries = Array.isArray(body.siteEntry) ? body.siteEntry : []
  const properties: GscProperty[] = []

  for (const entry of entries) {
    if (!isRecord(entry) || !nonEmptyString(entry["siteUrl"])) continue
    const level = entry["permissionLevel"]
    properties.push({
      siteUrl: entry["siteUrl"],
      permissionLevel: isPermission(level) ? level : "unverified",
    })
  }

  return properties
}

/**
 * Normalise any user-supplied URL to the key Search Console files it under.
 *
 * The domain property is the probe, because that is what a person means when
 * they paste `https://example.com` — Google filed that site as
 * `sc-domain:example.com`, not as a URL-prefix property. `status()` reconciles
 * the two shapes against the property list, so a URL-prefix property still
 * verifies; this function only decides what to look for first.
 */
export function normaliseSiteUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed.length === 0) throw new GscValidationError("A website URL is required.")

  if (trimmed.startsWith("sc-")) return trimmed

  let host: string
  try {
    host = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname
  } catch {
    throw new GscValidationError(`"${trimmed}" is not a URL.`)
  }
  host = host.toLowerCase().replace(/^www\./, "")
  if (host.length === 0) throw new GscValidationError(`"${trimmed}" has no hostname.`)
  return `sc-domain:${host}`
}

function hostOfSiteKey(siteKey: string): string | null {
  if (siteKey.startsWith("sc-domain:")) return siteKey.slice("sc-domain:".length).toLowerCase()
  try {
    return new URL(siteKey).hostname.toLowerCase().replace(/^www\./, "")
  } catch {
    return null
  }
}

/**
 * Verify a URL against the properties Google reports. `verified` is true only
 * when the property is actually listed — a `siteFullUser` grant verifies for
 * analytics but cannot write, which is why the level is returned rather than
 * flattened into a boolean.
 */
export async function status(url: string): Promise<GscStatus> {
  let siteUrl: string
  try {
    siteUrl = normaliseSiteUrl(url)
  } catch (error) {
    return {
      configured: isConfigured(),
      verified: false,
      siteUrl: null,
      permissionLevel: null,
      clientEmail: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  if (!isConfigured()) {
    return {
      configured: false,
      verified: false,
      siteUrl,
      permissionLevel: null,
      clientEmail: null,
      error: "No Search Console service account is connected on this machine.",
    }
  }

  try {
    const [properties, stored] = await Promise.all([listProperties(), readStoredPublicInfo()])
    const probeHost = hostOfSiteKey(siteUrl)

    const match =
      properties.find((property) => property.siteUrl === siteUrl) ??
      // A URL-prefix property still belongs to its host, so a domain probe
      // matches it. Domain properties keep priority via the exact lookup above.
      (probeHost
        ? properties.find((property) => hostOfSiteKey(property.siteUrl) === probeHost)
        : undefined)

    return {
      configured: true,
      verified: match !== undefined,
      siteUrl: match?.siteUrl ?? siteUrl,
      permissionLevel: match?.permissionLevel ?? null,
      clientEmail: stored?.clientEmail ?? null,
    }
  } catch (error) {
    return {
      configured: true,
      verified: false,
      siteUrl,
      permissionLevel: null,
      clientEmail: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function readStoredPublicInfo(): Promise<GscPublicInfo | null> {
  const stored = readJson(serviceAccountPath())
  if (!isRecord(stored)) return null
  try {
    return toPublicInfo(parseServiceAccount(stored))
  } catch {
    return null
  }
}

/**
 * Validate the upload, store it at the server-owned path, then prove access by
 * calling `listProperties`.
 *
 * Order matters: validation first, so a bad file never reaches disk; write
 * second, so a live verification has something to read; the reset of the token
 * cache third, so a re-connect cannot keep serving the previous key's token.
 *
 * Never returns the key, in the success shape or the failure shape.
 */
export async function connectServiceAccount(input: unknown): Promise<ConnectResult> {
  let account: Record<string, unknown>
  try {
    account = parseServiceAccount(input)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { connected: false, clientEmail: "", properties: [], error: message }
  }

  const info = toPublicInfo(account)
  const path = serviceAccountPath()

  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    // 0o600 at create time, not a chmod after — otherwise the key is briefly
    // world-readable between the write and the chmod.
    writeFileSync(path, `${JSON.stringify(account, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    chmodSync(path, 0o600)
  } catch (error) {
    return {
      connected: false,
      clientEmail: info.clientEmail,
      properties: [],
      error: `Could not store the service account: ${String(error)}`,
    }
  }

  resetTokenCache()

  try {
    const properties = await listProperties()
    return { connected: true, clientEmail: info.clientEmail, properties }
  } catch (error) {
    return {
      connected: false,
      clientEmail: info.clientEmail,
      properties: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
