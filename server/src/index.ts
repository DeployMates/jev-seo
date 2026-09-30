/**
 * HTTP surface. The audit runs as a newline-delimited JSON stream so the
 * dashboard can tick as judgements land rather than waiting for the report,
 * with the proxy-buffering headers that make that work in practice.
 *
 * One process, one port: this app serves the built UI as well as the API, so a
 * packaged install has no second server to start. In development Vite serves the
 * UI on its own port and proxies `/api` here — that split is a dev-only
 * convenience and deliberately does not exist in the shipped product.
 */
import express from "express"
import cors from "cors"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { DEFAULT_CONCURRENCY, DEFAULT_MAX_PAGES, PORT } from "./config.js"
import { envFileLoaded } from "./config.js"
import { dataDir, probeWritable, webDist } from "./paths.js"
import { proxyStatus } from "./zenProxy.js"
import { runAudit, type AuditEvent, type AuditKeywordSeed, type AuditMetric, type AuditRivalProposal } from "./audit.js"
import { HISTORY_LIMIT, diffRuns, loadHistory } from "./history.js"
import { crawlForResearch } from "./crawlDigest.js"
import {
  isCalibrated,
  isConfigured,
  judgeBackend,
  judgeModel,
  JevAuthError,
} from "./judge.js"
import { activeModel } from "./jevClient.js"
import {
  connectServiceAccount,
  isConfigured as gscConfigured,
  listProperties,
  readStoredPublicInfo,
  normaliseSiteUrl,
  status as gscStatus,
} from "./gsc.js"
import {
  activeAgentModel,
  isAgentAvailable,
  listAgentModels,
  setAgentModel,
  runResearch,
  type ResearchRequest,
} from "./agent.js"

const app = express()

app.use(cors())
app.use(express.json({ limit: "1mb" }))

function capacity() {
  return {
    jevConfigured: isConfigured(),
    jevModel: activeModel(),
    jevBackend: judgeBackend(),
    jevCalibrated: isCalibrated(),
    judgeRunning: judgeModel(),
    agentConfigured: isAgentAvailable(),
    agentModel: activeAgentModel(),
    gscConfigured: gscConfigured(),
    // The pool the keyless Zen tier actually egresses through. Reported rather
    // than assumed: `pool: 0` means the server started direct, which is a
    // legitimate configuration and a common cause of a keyless 429.
    proxy: proxyStatus(),
  }
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    ...capacity(),
    defaults: { maxPages: DEFAULT_MAX_PAGES, concurrency: DEFAULT_CONCURRENCY },
  })
})

app.get("/api/config", (_req, res) => {
  res.json({
    ...capacity(),
    defaults: { maxPages: DEFAULT_MAX_PAGES, concurrency: DEFAULT_CONCURRENCY },
  })
})

app.get("/api/agent/models", (_req, res) => {
  void listAgentModels()
    .then((models: string[]) => res.json({ models, selected: activeAgentModel() }))
    .catch((error: unknown) =>
      res.json({ models: [], selected: activeAgentModel(), error: (error as Error).message }),
    )
})

app.post("/api/agent/model", (req, res) => {
  const body = (req.body ?? {}) as { model?: unknown }
  if (typeof body.model !== "string" || body.model.trim().length === 0) {
    res.status(400).json({ error: "A model id is required." })
    return
  }
  res.json(setAgentModel(body.model.trim()))
})

app.get("/api/gsc/properties", (_req, res) => {
  void listProperties()
    .then(async (properties) => {
      // The account the key belongs to, so the UI can name which identity these
      // properties are reachable through. Read from the key itself rather than
      // carried on each property: one key, one account, N properties.
      let clientEmail: string | null = null
      try {
        clientEmail = (await readStoredPublicInfo())?.clientEmail ?? null
      } catch {
        /* properties answered, identity did not — the list is still useful */
      }
      res.json({ properties, clientEmail })
    })
    .catch((error: unknown) =>
      res.json({ properties: [], clientEmail: null, error: (error as Error).message }),
    )
})

app.get("/api/gsc/status", (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url : ""
  if (!url) {
    res.status(400).json({ error: "A url query parameter is required." })
    return
  }
  void gscStatus(url)
    .then((result) => res.json(result))
    .catch((error: unknown) =>
      res.json({
        connected: gscConfigured(),
        verified: false,
        site: normaliseSiteUrl(url),
        properties: [],
        error: (error as Error).message,
      }),
    )
})

app.post("/api/gsc/connect", (req, res) => {
  void connectServiceAccount(req.body)
    .then((result) => res.json(result))
    .catch((error: unknown) =>
      res.status(400).json({
        connected: false,
        clientEmail: "",
        properties: [],
        error: (error as Error).message,
      }),
    )
})

app.post("/api/research", (req, res) => {
  const body = (req.body ?? {}) as Partial<ResearchRequest>
  if (typeof body.url !== "string" || body.url.trim().length === 0) {
    res.status(400).json({ error: "A website URL is required." })
    return
  }
  const url = body.url.trim()

  // Newline-delimited, like the audit: the crawl and the opencode session are
  // two long waits, and a dashboard that shows nothing until both finish reads
  // as broken. Each line is one thing that already happened.
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8")
  res.setHeader("Cache-Control", "no-cache, no-transform")
  res.setHeader("Connection", "keep-alive")
  res.setHeader("X-Accel-Buffering", "no")
  res.flushHeaders?.()

  // `res`, not `req`: a POST request's `req` emits "close" as soon as its body
  // has been read, which is immediately. Listening there aborts the stream
  // after the first event.
  let closed = false
  const send = (event: Record<string, unknown>): void => {
    if (closed || res.writableEnded) return
    res.write(`${JSON.stringify(event)}\n`)
  }

  res.on("close", () => {
    closed = true
  })

  void (async () => {
    try {
      send({ type: "stage", stage: "crawl", detail: `fetching ${url}` })

      const gate = await gscStatus(url)
      const digest = await crawlForResearch(url, 12, 30_000, (event) => {
        send({ type: "crawl", ...event })
      })

      send({
        type: "stage",
        stage: "session",
        detail: `one opencode session over ${digest.result.pages.length} crawled page(s)`,
      })

      const result = await runResearch(
        { ...body, url, crawlSummary: digest.summary } as ResearchRequest,
        {
          gsc: {
            verified: gate.verified,
            permission:
              gate.permissionLevel === "siteOwner" || gate.permissionLevel === "siteFullUser"
                ? gate.permissionLevel
                : null,
            property: gate.siteUrl,
          },
        },
        (event) => send({ type: "session", ...event }),
      )

      if (result.degraded) {
        console.log(
          `[jev-seo] research degraded: reason=${result.reason} detail=${String(result.detail).slice(0, 300)}`,
        )
      } else {
        console.log(
          `[jev-seo] research ok: rivals=${result.data.competitors.length} seeds=${result.data.keyword_seeds.length} tools=${result.receipt.toolsCalled.length}`,
        )
      }
      send({ type: "result", ...result })
    } catch (error) {
      send({ type: "error", message: (error as Error).message })
    } finally {
      if (!closed && !res.writableEnded) res.end()
    }
  })()
})

app.post("/api/audit", (req, res) => {
  const body = req.body ?? {}
  const url = typeof body.url === "string" ? body.url.trim() : ""
  if (!url) {
    res.status(400).json({ error: "A website URL is required." })
    return
  }

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8")
  res.setHeader("Cache-Control", "no-store, no-transform")
  res.setHeader("X-Accel-Buffering", "no")
  res.setHeader("Connection", "keep-alive")
  res.flushHeaders?.()

  const send = (event: AuditEvent) => {
    if (res.writableEnded) return
    res.write(`${JSON.stringify(event)}\n`)
  }

  const controller = new AbortController()
  req.on("close", () => controller.abort())

  const competitors = Array.isArray(body.competitors)
    ? body.competitors.filter((value: unknown): value is string => typeof value === "string")
    : typeof body.competitors === "string"
      ? body.competitors.split(/[\n,]/).map((value: string) => value.trim()).filter(Boolean)
      : []

  // The presearch passthrough, filtered to the fields the schema guarantees. The
  // client already holds all three and they were being dropped here, which is
  // why the seed pool never reached the keyword pass: `keywordSeeds` is the only
  // source of a term we do not already say something about, so dropping it left
  // the gap panel with nothing to find.
  const keywordSeeds = Array.isArray(body.keywordSeeds)
    ? (body.keywordSeeds as unknown[])
        .filter(
          (value): value is AuditKeywordSeed =>
            typeof value === "object" &&
            value !== null &&
            typeof (value as { term?: unknown }).term === "string" &&
            (value as { term: string }).term.trim().length > 0,
        )
        .map((seed) => ({
          term: seed.term.trim(),
          intent: typeof seed.intent === "string" ? seed.intent : "unknown",
          evidence_tool:
            typeof seed.evidence_tool === "string" ? seed.evidence_tool : "presearch",
        }))
    : undefined

  const metrics = Array.isArray(body.metrics) ? (body.metrics as AuditMetric[]) : undefined
  const rivalProposals = Array.isArray(body.rivalProposals)
    ? (body.rivalProposals as AuditRivalProposal[])
    : undefined

  void runAudit(
    {
      url,
      businessName: body.businessName,
      businessContext: body.businessContext,
      market: body.market,
      maxPages: body.maxPages,
      maxKeywords: body.maxKeywords,
      maxGaps: body.maxGaps,
      maxCompetitors: body.maxCompetitors,
      concurrency: body.concurrency,
      runJev: body.runJev,
      competitors,
      keywordSeeds,
      metrics,
      rivalProposals,
    },
    send,
  )
    .catch((error: unknown) => {
      if (error instanceof JevAuthError) {
        send({ type: "error", url, message: "Jev is not configured on the server." })
      } else {
        send({ type: "error", url, message: (error as Error).message })
      }
    })
    .finally(() => {
      if (!res.writableEnded) res.end()
    })
})

app.get("/api/history", (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url.trim() : ""
  if (!url) {
    res.status(400).json({ error: "A url query parameter is required." })
    return
  }
  let root: string
  try {
    root = new URL(url).origin
  } catch {
    res.status(400).json({ error: "That url could not be read as a website address." })
    return
  }

  const runs = loadHistory(root)
  const [current, previous] = runs
  // A single run has no baseline, so `delta.baseline` is null rather than a diff
  // against itself — which would report every open page as "new" and imply
  // progress the site has not made.
  const delta = current ? diffRuns(current, previous ?? null) : null

  res.json({
    root,
    runs,
    delta,
    limit: HISTORY_LIMIT,
  })
})

/* -------------------------------------------------------------------------- */
/* the built UI                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Mounted after every API route, and `/api` is excluded explicitly: a catch-all
 * registered first would answer every `/api/...` call with `index.html`, and the
 * dashboard would hang on a 200 that is not JSON.
 */
const dist = webDist()

if (dist) {
  app.use(express.static(dist, { index: false, maxAge: "1h" }))

  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) {
      next()
      return
    }
    res.sendFile(resolve(dist, "index.html"))
  })
} else {
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) {
      next()
      return
    }
    res
      .status(503)
      .type("text/plain")
      .send("The web UI is not built. Run `npm --prefix <package> run build` and restart.")
  })
}

/* -------------------------------------------------------------------------- */
/* boot                                                                       */
/* -------------------------------------------------------------------------- */

/** At the door, not on the first GSC upload — a key that cannot be written is a
 *  broken install, and the worst moment to discover it is mid-session. */
const writable = probeWritable()
if (!writable.ok) {
  console.error(`[jev-seo] data dir is not writable: ${writable.path}`)
  console.error(`[jev-seo] ${writable.error ?? "unknown error"}`)
  console.error("[jev-seo] set JEV_DATA_DIR to a writable path, e.g. JEV_DATA_DIR=~/.jev-seo")
  process.exit(1)
}

app.listen(PORT, () => {
  const caps = capacity()
  console.log(`[jev-seo] server + UI on http://localhost:${PORT}`)
  console.log(
    `[jev-seo] jev: ${caps.jevConfigured ? caps.jevModel : "not configured"} | ` +
      `agent: ${caps.agentConfigured ? caps.agentModel : "not available"} | ` +
      `gsc: ${caps.gscConfigured ? "connected" : "not connected"}`,
  )
  console.log(`[jev-seo] data: ${dataDir()}`)
  console.log(`[jev-seo] ui: ${dist ?? "not built"}`)
  console.log(
    envFileLoaded
      ? `[jev-seo] env: ${envFileLoaded.path} (${envFileLoaded.keys.join(", ")})`
      : "[jev-seo] env: none loaded, using defaults",
  )
})
