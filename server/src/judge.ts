/**
 * Which judge answers the questions. TypeSafe's Jev when a credential exists,
 * otherwise the local keyless opencode model — same signature, same answer
 * shapes, so nothing downstream branches on the backend except the label the
 * dashboard shows, which must be honest about which one ran.
 */
import { zenKey } from "./config.js"
import {
  activeModel,
  JevAuthError,
  systemOne as jevSystemOne,
  type JevResult,
} from "./jevClient.js"
import { localJudgeModel, localSystemOne } from "./localJudge.js"
import { isAgentAvailable } from "./agent.js"
import type { Questions } from "./questions.js"

export type JudgeBackend = "zen" | "local"

export function judgeBackend(): JudgeBackend {
  return zenKey() ? "zen" : "local"
}

export function judgeModel(): string {
  return judgeBackend() === "zen" ? activeModel() : localJudgeModel()
}

/**
 * Whether a judge can run at all, which is what the audit gate needs. Zen
 * needs nothing (the keyless `public` credential), and the local judge needs
 * the `opencode` binary — so this is true unless someone disabled both.
 * Gating on `zenKey() !== undefined` instead would switch judging OFF exactly
 * when Zen is unreachable, which is backwards.
 */
export function isConfigured(): boolean {
  return judgeBackend() === "zen" || isAgentAvailable()
}

/** Zen serves real Jev, trained for calibrated decisions (RLCD). A chat model
 * asked for a probability returns a plausible number, not a calibrated one, so
 * the local fallback must never claim calibration it does not have. */
export function isCalibrated(): boolean {
  return judgeBackend() === "zen"
}

export { activeModel, JevAuthError }
export type {
  Answer,
  Answers,
  ChoiceAnswer,
  JevReceipt,
  JevResult,
  NoulAnswer,
  ScoreAnswer,
} from "./jevClient.js"

export async function systemOne(
  state: unknown,
  questions: Questions,
  options: { model?: string; signal?: AbortSignal } = {},
): Promise<JevResult> {
  if (zenKey()) return jevSystemOne(state, questions, options)
  return localSystemOne(state, questions, { signal: options.signal })
}
