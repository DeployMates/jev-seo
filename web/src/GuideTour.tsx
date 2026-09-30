import { useEffect, useState } from "react"
import { Joyride } from "react-joyride"
import { TOUR_STEPS } from "./tourSteps"

const SEEN_KEY = "jev.tour.seen.v1"

/**
 * react-joyride v3.2.0 — the newest release published to this registry.
 *
 * Two things about this version are worth knowing before editing it:
 *
 * 1. It is **not** the API most examples online show. There is no default
 *    export (it is a named `Joyride`), there is no `callback` prop (it is
 *    `onEvent`, which hands you a `Controls` handle as a second argument),
 *    and every visual/behavioural flag lives under a single `options` object
 *    rather than at the top level. `showSkipButton` does not exist — the skip
 *    button is opted into via `options.buttons`.
 *
 * 2. It runs **uncontrolled** here on purpose. Controlled mode means
 *    threading a step index through `onEvent` by hand; uncontrolled lets
 *    Joyride own the index and we only listen for `tour:end`. Restarting is
 *    done by bumping `key`, which remounts the component and resets the index
 *    to 0 — a boolean that only goes false -> true cannot do that.
 *
 * `startSignal` is a counter rather than a boolean for the same reason: the
 * header button has to be able to replay the tour after it has finished.
 */
export function GuideTour({
  startSignal,
  onFinish,
}: {
  startSignal: number
  onFinish?: () => void
}) {
  const [run, setRun] = useState(false)
  const [nonce, setNonce] = useState(0)

  // First visit: offer the tour unless this browser has already had it.
  useEffect(() => {
    if (startSignal > 0) return
    let seen = false
    try {
      seen = window.localStorage.getItem(SEEN_KEY) === "1"
    } catch {
      seen = false // storage blocked (private mode): show it rather than hide it
    }
    if (!seen) {
      setRun(true)
      try {
        window.localStorage.setItem(SEEN_KEY, "1")
      } catch {
        /* non-fatal — worst case it offers itself again next load */
      }
    }
  }, [startSignal])

  // Header button pressed: remount from step 0.
  useEffect(() => {
    if (startSignal > 0) {
      setNonce((n) => n + 1)
      setRun(true)
    }
  }, [startSignal])

  return (
    <Joyride
      key={nonce}
      run={run}
      steps={TOUR_STEPS}
      continuous
      scrollToFirstStep
      onEvent={data => {
        if (data.type === "tour:end") {
          setRun(false)
          onFinish?.()
        }
      }}
      locale={{
        back: "Back",
        close: "Close",
        last: "Done",
        next: "Next",
        skip: "Skip tour",
      }}
      styles={{
        tooltip: {
          borderRadius: 10,
          padding: "16px 18px",
          fontSize: 14,
          lineHeight: 1.55,
          fontFamily: "inherit",
        },
        tooltipContainer: { padding: 12 },
        buttonPrimary: { backgroundColor: "#d8d5ce", color: "#12100c", borderRadius: 6 },
        buttonBack: { color: "#9d9a92" },
        buttonSkip: { color: "#6f6d66" },
        buttonClose: { color: "#6f6d66" },
      }}
      options={{
        backgroundColor: "#12100c",
        textColor: "#f4f2ec",
        primaryColor: "#d8d5ce",
        arrowColor: "#12100c",
        overlayColor: "rgba(8,7,6,0.74)",
        width: 372,
        zIndex: 90,
        showProgress: true,
        buttons: ["back", "close", "skip", "primary"],
        // Deliberate: the tour is opt-out, not opt-in. A stray click outside
        // the tooltip should not dismiss an explanation the user has not read.
        overlayClickAction: false,
        dismissKeyAction: "close",
        blockTargetInteraction: false,
        spotlightRadius: 10,
        offset: 12,
        scrollOffset: 24,
        targetWaitTimeout: 500,
      }}
    />
  )
}