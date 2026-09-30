// Verification harness: stands up a local endpoint shaped like the documented
// Jev response, then asserts the whole pipeline end to end.
import { ZEN_BASE_URL, zenKey } from "./config.js"

process.env.ZEN_BASE_URL = "http://127.0.0.1:8799/v1"
process.env.OPENCODE_API_KEY = "mock-key-for-pipeline-verification"

void import("./mock-jev-verify.js")
