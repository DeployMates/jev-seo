import { useEffect, useRef, useState } from "react"
import { API } from "./api"

/**
 * The Search Console properties the connected service account can reach, as
 * `/api/gsc/properties` reports them: Google's own site key plus the permission
 * level this account holds on it. One key, one identity, N properties — so the
 * account is named once at the top rather than repeated per row.
 *
 * Choosing a property fills the URL field rather than starting a run. The site
 * key is `sc-domain:example.com` and the field wants a URL, so the domain is
 * lifted out and given a scheme; a property already stored as a URL prefix keeps
 * whatever it had.
 */
export interface GscProperty {
  siteUrl: string
  permissionLevel: string
}

const PERMISSION_LABEL: Record<string, string> = {
  siteOwner: "Owner",
  siteFullUser: "Full",
  siteRestrictedUser: "Restricted",
  notPermitted: "No access",
}

/** Google's own key forms: `sc-domain:example.com` or `https://example.com/`. */
export function propertyToUrl(siteUrl: string): string {
  const scoped = siteUrl.startsWith("sc-domain:")
    ? siteUrl.slice("sc-domain:".length)
    : null
  if (scoped) return `https://${scoped}`
  if (/^https?:\/\//i.test(siteUrl)) return siteUrl
  return `https://${siteUrl}`
}

/** The bare host, for the favicon lookup and for the label. */
function hostOf(siteUrl: string): string {
  return propertyToUrl(siteUrl).replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
}

interface Props {
  onPick: (url: string, property: GscProperty) => void
}

export function PropertyPicker({ onPick }: Props) {
  const [properties, setProperties] = useState<GscProperty[]>([])
  const [clientEmail, setClientEmail] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(`${API}/api/gsc/properties`)
        const data = (await response.json()) as {
          properties?: GscProperty[]
          clientEmail?: string | null
        }
        if (cancelled) return
        setProperties(Array.isArray(data.properties) ? data.properties : [])
        setClientEmail(data.clientEmail ?? null)
      } catch {
        /* no key, or the route is unreachable: the input still works by hand */
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

  if (properties.length === 0) return null

  return (
    <div className="picker" ref={wrapRef}>
      <button
        type="button"
        className="picker-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={`Search Console properties reachable by ${clientEmail ?? "the connected account"}`}
      >
        <span className="picker-count">{properties.length}</span>
        <span className="picker-label">Connected sites</span>
        <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M18 15l-6-6-6 6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="picker-panel" role="listbox">
          {clientEmail && (
            <p className="picker-account" title={clientEmail}>
              <span className="picker-account-k">account</span>
              <span className="picker-account-v">{clientEmail}</span>
            </p>
          )}
          <ul className="picker-list">
            {properties.map((property) => (
              <li key={property.siteUrl}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="picker-row"
                  onClick={() => {
                    onPick(propertyToUrl(property.siteUrl), property)
                    setOpen(false)
                  }}
                >
                  <img
                    className="picker-fav"
                    src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostOf(property.siteUrl))}&sz=32`}
                    alt=""
                    width={16}
                    height={16}
                    loading="lazy"
                    onError={(event) => {
                      // Google's favicon service 404s for domains it has no icon
                      // for, which leaves a broken-image glyph in the row.
                      event.currentTarget.style.visibility = "hidden"
                    }}
                  />
                  <span className="picker-host">{hostOf(property.siteUrl)}</span>
                  <span
                    className={`picker-perm ${
                      property.permissionLevel === "notPermitted" ? "no" : ""
                    }`}
                  >
                    {PERMISSION_LABEL[property.permissionLevel] ?? property.permissionLevel}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
