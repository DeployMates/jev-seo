#!/usr/bin/env node
/**
 * jev-seo — start, stop, inspect.
 *
 * Plain JavaScript with no dependencies, on purpose: this file is the one thing
 * that must work before anything else has loaded, including the build it is
 * about to launch. It imports the compiled `paths.js` so the data directory has
 * exactly one definition, but it checks for that file first and says something
 * useful when it is missing rather than throwing ERR_MODULE_NOT_FOUND.
 *
 * Lifecycle notes:
 *   - `stop` kills by PID from a PID file. Never by process-name pattern:
 *     `pkill -f vite` takes down every Vite on the machine, including other
 *     people's projects.
 *   - `SIGTERM` first, `SIGKILL` only after a grace period, so an in-flight
 *     audit is not cut off mid-write.
 */
import { spawn } from "node:child_process"
import { existsSync, readFileSync, unlinkSync, writeFileSync, openSync } from "node:fs"
import { createConnection } from "node:net"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SERVER_ENTRY = resolve(ROOT, "server", "dist", "index.js")
const PATHS_MODULE = resolve(ROOT, "server", "dist", "paths.js")
const DEFAULT_PORT = 8787

/* -------------------------------------------------------------------------- */
/* argv                                                                        */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const flags = { detach: false, port: null }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--detach" || arg === "-d") flags.detach = true
    else if (arg === "--port" || arg === "-p") {
      const value = Number(argv[i + 1])
      if (Number.isInteger(value) && value > 0 && value < 65536) {
        flags.port = value
        i += 1
      } else {
        die(`--port needs a number between 1 and 65535, got ${JSON.stringify(argv[i + 1])}`)
      }
    } else rest.push(arg)
  }
  return { flags, rest }
}

function die(message, code = 1) {
  console.error(`jev-seo: ${message}`)
  process.exit(code)
}

/* -------------------------------------------------------------------------- */
/* paths, loaded from the build so there is one definition of the data dir     */
/* -------------------------------------------------------------------------- */

async function loadPaths() {
  if (!existsSync(PATHS_MODULE)) {
    die(
      "this copy is not built.\n" +
        `  expected: ${PATHS_MODULE}\n` +
        "  fix:      npm --prefix " + ROOT + " run build",
    )
  }
  return import(pathToFileURL(PATHS_MODULE).href)
}

/* -------------------------------------------------------------------------- */
/* port helpers                                                                */
/* -------------------------------------------------------------------------- */

function portFree(port) {
  return new Promise((resolveAnswer) => {
    const socket = createConnection({ port, host: "127.0.0.1" })
    const done = (busy) => {
      socket.destroy()
      resolveAnswer(!busy)
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
    setTimeout(() => done(false), 1000)
  })
}

async function waitForHealth(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (res.ok) return await res.json()
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}

/* -------------------------------------------------------------------------- */
/* commands                                                                    */
/* -------------------------------------------------------------------------- */

async function readPid(paths) {
  const file = paths.pidFilePath()
  if (!existsSync(file)) return null
  const pid = Number(readFileSync(file, "utf8").trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

async function cmdStart(flags) {
  const paths = await loadPaths()
  if (!existsSync(SERVER_ENTRY)) {
    die(`server build missing at ${SERVER_ENTRY} — run \`npm --prefix ${ROOT} run build\``)
  }

  const existing = await readPid(paths)
  if (existing && alive(existing)) {
    console.log(`already running (pid ${existing}) — \`jev-seo status\` for the URL`)
    return
  }
  if (existing) unlinkSync(paths.pidFilePath())

  const port = flags.port ?? Number(process.env.PORT ?? DEFAULT_PORT)
  if (!(await portFree(port))) {
    const stale = await readPid(paths)
    die(
      `port ${port} is already in use` +
        (stale && alive(stale) ? "" : " by another process") +
        `.\n  fix: jev-seo stop        (if a previous jev-seo is running)\n` +
        `       jev-seo start --port ${port + 1}`,
    )
  }

  const env = { ...process.env, PORT: String(port) }

  if (!flags.detach) {
    console.log(`[jev-seo] starting on http://localhost:${port} (ctrl-c to stop)`)
    const child = spawn(process.execPath, [SERVER_ENTRY], { stdio: "inherit", env })
    child.on("exit", (code) => process.exit(code ?? 0))
    return
  }

  paths.logsDir()
  const logFile = paths.serverLogPath()
  const out = openSync(logFile, "a")
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    detached: true,
    stdio: ["ignore", out, out],
    env,
  })
  child.unref()
  writeFileSync(paths.pidFilePath(), `${child.pid}\n`, "utf8")

  const health = await waitForHealth(port)
  if (!health) {
    console.log(`[jev-seo] started (pid ${child.pid}) but /api/health did not answer in 30s`)
    console.log(`[jev-seo] log: ${logFile}`)
    process.exit(1)
  }
  console.log(`[jev-seo] pid ${child.pid} — http://localhost:${port}`)
  console.log(`[jev-seo] log: ${logFile}`)
  console.log(`[jev-seo] stop with: jev-seo stop`)
}

async function cmdStop() {
  const paths = await loadPaths()
  const pid = await readPid(paths)
  if (!pid) {
    console.log("not running (no pid file)")
    return
  }
  if (!alive(pid)) {
    unlinkSync(paths.pidFilePath())
    console.log(`not running (stale pid ${pid} removed)`)
    return
  }

  console.log(`stopping pid ${pid}…`)
  try {
    process.kill(pid, "SIGTERM")
  } catch (error) {
    die(`could not signal pid ${pid}: ${error.message}`)
  }

  for (let waited = 0; waited < 8000; waited += 200) {
    if (!alive(pid)) {
      unlinkSync(paths.pidFilePath())
      console.log("stopped")
      return
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  console.log("still alive after 8s, sending SIGKILL")
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    /* already gone */
  }
  unlinkSync(paths.pidFilePath())
  console.log("killed")
}

async function cmdStatus(flags) {
  const paths = await loadPaths()
  const pid = await readPid(paths)
  const port = flags.port ?? Number(process.env.PORT ?? DEFAULT_PORT)

  console.log(`pid file: ${paths.pidFilePath()}`)
  if (!pid) {
    console.log("state:    not running (no pid file)")
  } else if (alive(pid)) {
    console.log(`state:    running (pid ${pid})`)
  } else {
    console.log(`state:    not running (stale pid ${pid})`)
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`)
    const body = await res.json()
    console.log(`health:   ok on port ${port}`)
    console.log(`          jev=${body.jevConfigured ? body.jevModel : "not configured"}`)
    console.log(`          agent=${body.agentConfigured ? body.agentModel : "not available"}`)
    console.log(`          gsc=${body.gscConfigured ? "connected" : "not connected"}`)
  } catch {
    console.log(`health:   no answer on port ${port}`)
  }
  console.log(`url:      http://localhost:${port}`)
}

async function cmdRestart(flags) {
  await cmdStop()
  await cmdStart(flags)
}

/* -------------------------------------------------------------------------- */
/* doctor                                                                      */
/* -------------------------------------------------------------------------- */

function mark(level, label, detail) {
  const tag = level === "ok" ? " ok " : level === "warn" ? " opt " : "FAIL "
  console.log(`  [${tag}] ${label}${detail ? ` — ${detail}` : ""}`)
}

async function cmdDoctor(flags) {
  const paths = await loadPaths()
  const port = flags.port ?? Number(process.env.PORT ?? DEFAULT_PORT)
  let failed = 0

  console.log("node")
  const major = Number(process.versions.node.split(".")[0])
  mark(major >= 20 ? "ok" : "fail", `v${process.versions.node}`, major >= 20 ? "" : "needs >= 20.11")
  if (major < 20) failed += 1

  console.log("\ndata directory")
  const probe = paths.probeWritable()
  mark(probe.ok ? "ok" : "fail", probe.path, probe.ok ? "writable" : probe.error)
  if (!probe.ok) failed += 1

  console.log("\nweb UI")
  const dist = paths.webDist()
  mark(dist ? "ok" : "fail", dist ?? "not found", dist ? "built" : "run `npm run build`")
  if (!dist) failed += 1

  console.log("\nserver build")
  mark(existsSync(SERVER_ENTRY) ? "ok" : "fail", SERVER_ENTRY, existsSync(SERVER_ENTRY) ? "present" : "missing")

  console.log("\noptional capabilities")
  const which = spawn("which", ["opencode"], { stdio: ["ignore", "pipe", "ignore"] })
  const hasOpencode = await new Promise((answer) => {
    which.on("exit", (code) => answer(code === 0))
    which.on("error", () => answer(false))
  })
  mark(
    hasOpencode ? "ok" : "warn",
    "opencode on PATH",
    hasOpencode ? "deep research available" : "absent — /api/audit still works, /api/research will degrade",
  )

  const uv = spawn("which", ["uv"], { stdio: ["ignore", "pipe", "ignore"] })
  const hasUv = await new Promise((answer) => {
    uv.on("exit", (code) => answer(code === 0))
    uv.on("error", () => answer(false))
  })
  mark(
    hasUv ? "ok" : "warn",
    "uv (python MCP)",
    hasUv ? "present" : "absent — only affects the optional agent-side GSC tools",
  )

  console.log("\noptional configuration")
  const keyPath = paths.gscKeyPath()
  const hasKey = existsSync(keyPath)
  let detail = "not set — audit works without it"
  if (hasKey) {
    try {
      const parsed = JSON.parse(readFileSync(keyPath, "utf8"))
      detail = `${parsed.client_email ?? "unknown client"}`
    } catch {
      detail = "present but unreadable"
    }
  }
  mark("warn", `GSC service account (${keyPath})`, detail)

  const proxies = paths.proxiesPath()
  let proxyDetail = "not set — crawling direct"
  if (proxies) {
    try {
      proxyDetail = `${readFileSync(proxies, "utf8").split("\n").filter((l) => l.trim()).length} entries (${proxies})`
    } catch {
      proxyDetail = `configured at ${proxies} but unreadable`
    }
  }
  mark("warn", "proxy pool", proxyDetail)

  console.log("\nport")
  const free = await portFree(port)
  mark(free ? "ok" : "warn", `${port}`, free ? "free" : "in use")

  console.log(failed === 0 ? "\nready." : `\n${failed} required check(s) failed.`)
  process.exit(failed === 0 ? 0 : 1)
}

function cmdVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"))
    console.log(pkg.version ?? "unknown")
  } catch {
    console.log("unknown")
  }
}

function usage() {
  console.log(`jev-seo — SEO + AI-search audit dashboard

  jev-seo                    start in the foreground on port ${DEFAULT_PORT}
  jev-seo start [--detach]   start; --detach runs it in the background
  jev-seo stop               stop a detached instance
  jev-seo restart            stop, then start
  jev-seo status             pid, port and /api/health
  jev-seo doctor             preflight checks (required vs optional)
  jev-seo version            print the version

  --port <n>                 override the port (default ${DEFAULT_PORT})

Environment:
  JEV_DATA_DIR               where state lives (default ~/.jev-seo)
  PORT                       default port
  JEV_ENV_FILE               explicit .env path
  JEV_WEB_DIST               explicit built-UI path
  AGENT_PROJECT_DIR          project dir for the optional research agent`)
}

/* -------------------------------------------------------------------------- */

const { flags, rest } = parseArgs(process.argv.slice(2))
const command = rest[0] ?? "start"

switch (command) {
  case "start":
    await cmdStart(flags)
    break
  case "stop":
    await cmdStop()
    break
  case "restart":
    await cmdRestart(flags)
    break
  case "status":
    await cmdStatus(flags)
    break
  case "doctor":
    await cmdDoctor(flags)
    break
  case "version":
    cmdVersion()
    break
  case "help":
  case "--help":
  case "-h":
    usage()
    break
  default:
    console.error(`jev-seo: unknown command "${command}"`)
    usage()
    process.exit(1)
}
