import json
import os
import re
import urllib.robotparser
from html.parser import HTMLParser
from urllib.parse import urlparse

import httpx

from gsc_mcp.meta import with_meta
from gsc_mcp.url_safety import URLSafetyError, safe_fetch_html, validate_url_strict

_REQUIRED_FIELDS = {
    "LocalBusiness":       ["name", "@type"],
    "Organization":        ["name", "@type"],
    "FAQPage":             ["mainEntity"],
    "Article":             ["headline", "author", "datePublished"],
    "BlogPosting":         ["headline", "author", "datePublished"],
    "WebSite":             ["name", "url"],
    "BreadcrumbList":      ["itemListElement"],
    "Product":             ["name", "offers"],
    "SoftwareApplication": ["name", "applicationCategory", "operatingSystem"],
}


_DEPRECATED_RICH_RESULTS = {
    "FAQPage":              "deprecated for rich results May 2026 (Google Search Central)",
    "HowTo":               "deprecated for rich results September 2023",
    "ClaimReview":         "deprecated for rich results June 2025",
    "EstimatedSalary":     "deprecated for rich results June 2025",
    "VehicleListing":      "deprecated for rich results June 2025",
    "SpecialAnnouncement": "deprecated for rich results June 2025",
}


_PATTERN_RECOMMENDATIONS = [
    (r"/faq",      "FAQPage"),
    (r"/blog/",    "BlogPosting"),
    (r"/contact",  "ContactPage"),
    (r"/product",  "Product"),
    (r"/glossary", "DefinedTermSet"),
]


class _JsonLdExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self._in_ld = False
        self._chunks: list[str] = []
        self.schemas: list[dict] = []

    def handle_starttag(self, tag, attrs):
        if tag == "script" and dict(attrs).get("type") == "application/ld+json":
            self._in_ld = True
            self._chunks = []

    def handle_endtag(self, tag):
        if tag == "script" and self._in_ld:
            self._in_ld = False
            raw = "".join(self._chunks).strip()
            if raw:
                try:
                    data = json.loads(raw)
                    if isinstance(data, list):
                        self.schemas.extend(data)
                    else:
                        self.schemas.append(data)
                except json.JSONDecodeError:
                    pass

    def handle_data(self, data):
        if self._in_ld:
            self._chunks.append(data)


def schema_validate(url: str) -> str:
    """Fetch a URL and validate its JSON-LD structured data schemas.

    Detects all <script type="application/ld+json"> blocks, checks required
    fields per schema type, and suggests missing schemas based on URL patterns.
    Does not require authentication -- works on any public URL.

    Returns detected schemas, validation results per schema, and recommendations.
    Verdicts: healthy (all schemas valid) | missing_schemas (none found) |
              invalid_schemas (found but at least one has missing required fields) |
              fetch_error (URL not reachable).
    """
    try:
        validate_url_strict(url)
    except URLSafetyError as e:
        return json.dumps(with_meta(
            {"url": url, "error": str(e), "verdict": "fetch_error"},
            tool="schema_validate",
            params={"url": url},
        ))
    try:
        with httpx.Client(timeout=15, follow_redirects=False) as client:
            resp = client.get(url, headers={"User-Agent": "gsc-mcp-schema-validator/1.0"})
            resp.raise_for_status()
            html = resp.text
    except httpx.HTTPError as e:
        return json.dumps(with_meta(
            {"url": url, "error": str(e), "verdict": "fetch_error"},
            tool="schema_validate",
            params={"url": url},
        ))

    parser = _JsonLdExtractor()
    parser.feed(html)

    detected: list[dict] = []
    for schema in parser.schemas:
        schema_type = schema.get("@type", "Unknown")
        required = _REQUIRED_FIELDS.get(schema_type, [])
        missing = [f for f in required if f not in schema]
        deprecated_note = _DEPRECATED_RICH_RESULTS.get(schema_type)
        detected.append({
            "type": schema_type,
            "valid": not missing,
            "missing_required_fields": missing,
            "fields_present": [k for k in schema if not k.startswith("@")],
            "deprecated_rich_result": deprecated_note,
        })

    detected_types = {s["type"] for s in detected}
    recommendations = [
        schema_type
        for pattern, schema_type in _PATTERN_RECOMMENDATIONS
        if re.search(pattern, url, re.IGNORECASE) and schema_type not in detected_types
    ]

    if not detected:
        verdict = "missing_schemas"
    elif all(s["valid"] for s in detected):
        verdict = "healthy"
    else:
        verdict = "invalid_schemas"

    return json.dumps(with_meta(
        {
            "url": url,
            "schemas_detected": len(detected),
            "schemas": detected,
            "recommendations": recommendations,
            "verdict": verdict,
        },
        tool="schema_validate",
        params={"url": url},
    ))


# ---------------------------------------------------------------------------
# (https://github.com/AgriciDaniel/claude-seo, MIT, Copyright (c) 2026 agricidaniel)
# ---------------------------------------------------------------------------


def _strip_nones(payload: object) -> object:
    """Recursively remove None-valued keys from dicts (keeps JSON-LD output tight)."""
    if isinstance(payload, dict):
        return {k: _strip_nones(v) for k, v in payload.items() if v is not None}
    if isinstance(payload, list):
        return [_strip_nones(v) for v in payload]
    return payload


def ai_visibility_audit(url: str) -> str:
    """Check robots.txt AI crawler access and llms.txt presence for a URL's origin.

    Fetches {origin}/robots.txt and checks each known AI crawler agent.
    Also checks for {origin}/llms.txt (Model Context Protocol discoverability file).
    No authentication required.

    Verdicts: open (all AI crawlers allowed) | partial (some blocked) |
              closed (all blocked or disallow all) | fetch_error.
    """
    try:
        validate_url_strict(url)
    except URLSafetyError as e:
        return json.dumps(with_meta(
            {"url": url, "error": str(e), "verdict": "fetch_error"},
            tool="ai_visibility_audit",
            params={"url": url},
        ))

    parsed = urlparse(url)
    origin = f"{parsed.scheme}://{parsed.netloc}"

    robots_txt_found = False
    robots_text = ""
    try:
        robots_text, _ = safe_fetch_html(f"{origin}/robots.txt")
        robots_txt_found = True
    except (httpx.HTTPError, URLSafetyError):
        robots_txt_found = False

    rp = urllib.robotparser.RobotFileParser()
    if robots_txt_found:
        rp.parse(robots_text.splitlines())

    crawlers: list[dict] = []
    for agent, description in _AI_CRAWLERS.items():
        allowed = rp.can_fetch(agent, url) if robots_txt_found else True
        crawlers.append({"agent": agent, "description": description, "allowed": allowed})

    llms_txt_present = False
    try:
        safe_fetch_html(f"{origin}/llms.txt")
        llms_txt_present = True
    except (httpx.HTTPError, URLSafetyError):
        llms_txt_present = False

    allowed_count = sum(c["allowed"] for c in crawlers)
    total_crawlers = len(crawlers)

    if not robots_txt_found:
        verdict = "open"
    elif allowed_count == total_crawlers:
        verdict = "open"
    elif allowed_count == 0:
        verdict = "closed"
    else:
        verdict = "partial"

    return json.dumps(with_meta(
        {
            "url": url,
            "origin": origin,
            "robots_txt_found": robots_txt_found,
            "llms_txt_present": llms_txt_present,
            "crawlers": crawlers,
            "allowed_count": allowed_count,
            "total_crawlers": total_crawlers,
            "verdict": verdict,
        },
        tool="ai_visibility_audit",
        params={"url": url},
    ))


# ---------------------------------------------------------------------------
# gbp_deprecation_lint
# ---------------------------------------------------------------------------



def pagespeed_audit(url: str, strategy: str = "mobile") -> str:
    """Run a PageSpeed Insights audit via Google's PSI API v5.

    Requires GOOGLE_API_KEY environment variable (plain API key, not service account).
    The PageSpeed Insights API must be enabled in the GCP project.

    strategy: "mobile" (default) or "desktop".
    Returns Lighthouse performance score, Core Web Vitals, and top opportunities.
    Verdicts: good (score>=90) | needs_improvement (50-89) | poor (<50) | missing_key | fetch_error.
    """
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        return json.dumps(with_meta(
            {"url": url, "error": "GOOGLE_API_KEY not set", "verdict": "missing_key"},
            tool="pagespeed_audit",
            params={"url": url, "strategy": strategy},
        ))

    try:
        validate_url_strict(url)
    except URLSafetyError as e:
        return json.dumps(with_meta(
            {"url": url, "error": str(e), "verdict": "fetch_error"},
            tool="pagespeed_audit",
            params={"url": url, "strategy": strategy},
        ))

    psi_url = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
    try:
        with httpx.Client(timeout=60) as client:
            resp = client.get(psi_url, params={"url": url, "strategy": strategy, "key": api_key})
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as e:
        return json.dumps(with_meta(
            {"url": url, "error": str(e), "verdict": "fetch_error"},
            tool="pagespeed_audit",
            params={"url": url, "strategy": strategy},
        ))

    lhr = data.get("lighthouseResult", {})
    categories = lhr.get("categories", {})
    perf_score = categories.get("performance", {}).get("score")
    perf_score_pct = round(perf_score * 100) if perf_score is not None else None

    audits = lhr.get("audits", {})

    def _metric(key: str) -> dict:
        a = audits.get(key, {})
        return {
            "display_value": a.get("displayValue"),
            "score": a.get("score"),
            "numeric_value": a.get("numericValue"),
        }

    cwv = {
        "fcp":         _metric("first-contentful-paint"),
        "lcp":         _metric("largest-contentful-paint"),
        "tbt":         _metric("total-blocking-time"),
        "cls":         _metric("cumulative-layout-shift"),
        "speed_index": _metric("speed-index"),
        "tti":         _metric("interactive"),
    }

    opportunities: list[dict] = []
    for key, audit in audits.items():
        details = audit.get("details", {})
        if details.get("type") == "opportunity" and audit.get("score", 1) < 0.9:
            opportunities.append({
                "id": key,
                "title": audit.get("title"),
                "description": audit.get("description"),
                "score": audit.get("score"),
            })
    opportunities.sort(key=lambda x: x.get("score") or 0)
    top_opportunities = opportunities[:3]

    if perf_score_pct is None:
        verdict = "fetch_error"
    elif perf_score_pct >= 90:
        verdict = "good"
    elif perf_score_pct >= 50:
        verdict = "needs_improvement"
    else:
        verdict = "poor"

    return json.dumps(with_meta(
        {
            "url": url,
            "strategy": strategy,
            "performance_score": perf_score_pct,
            "cwv": cwv,
            "top_opportunities": top_opportunities,
            "verdict": verdict,
        },
        tool="pagespeed_audit",
        params={"url": url, "strategy": strategy},
    ))
