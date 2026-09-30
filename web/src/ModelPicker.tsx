import { useEffect, useRef, useState } from "react"
import { API } from "./api"

interface Props {
  current: string
  onChanged: (model: string) => void
}

/**
 * The agent model, chosen from the models the Zen gateway actually advertises.
 * The list comes from the server rather than being typed in here, so a new Zen
 * release is selectable without a code change — and a model this dropdown does
 * not know about is not something the run can silently fail on.
 *
 * The choice is persisted server-side, so it outlives a restart and is the same
 * answer for every later run.
 */
export function ModelPicker({ current, onChanged }: Props) {
  const [models, setModels] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(`${API}/api/agent/models`)
        const data = (await response.json()) as { models?: string[]; error?: string }
        if (cancelled) return
        if (data.error) {
          setError(data.error)
          return
        }
        setModels(Array.isArray(data.models) ? data.models : [])
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const onAway = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onAway)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onAway)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const pick = async (model: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`${API}/api/agent/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      })
      const data = (await response.json()) as { model?: string; error?: string }
      if (data.error) {
        setError(data.error)
        return
      }
      onChanged(data.model ?? model)
      setOpen(false)
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const needle = filter.trim().toLowerCase()
  const shown = needle ? models.filter((m) => m.toLowerCase().includes(needle)) : models

  return (
    <div className="modelpick" ref={wrapRef}>
      <button
        type="button"
        className="modelpick-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={`Agent model — ${current}`}
      >
        <span className="modelpick-now">{current || "no model"}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M18 15l-6-6-6 6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="modelpick-panel" role="dialog" aria-label="Choose the agent model">
          <input
            className="modelpick-search"
            type="text"
            placeholder={`Filter ${models.length} models`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
          {error && <p className="modelpick-err">{error}</p>}
          <ul className="modelpick-list">
            {shown.map((model) => (
              <li key={model}>
                <button
                  type="button"
                  className={`modelpick-row${model === current ? " current" : ""}`}
                  disabled={busy}
                  onClick={() => void pick(model)}
                >
                  <span>{model}</span>
                  {model === current && <span className="modelpick-tick">current</span>}
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="modelpick-empty">no model matches</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
