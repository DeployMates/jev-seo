import json
from urllib.parse import urlparse

import defusedxml.ElementTree as ET
from defusedxml import DefusedXmlException
import httpx

from gsc_mcp.auth import get_indexing_service, get_searchconsole_service
from gsc_mcp.meta import with_meta
from gsc_mcp.quota import QuotaTracker
from gsc_mcp.constants import QUOTA_INDEXING_LIMIT, QUOTA_INDEXING_WARN_AT
from gsc_mcp.retry import with_retry
from gsc_mcp.tools.inspection import _parse_inspection
from gsc_mcp.url_safety import URLSafetyError, validate_url_strict

_INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow"

_BATCH_SIZE = 100

_default_quota = QuotaTracker(limit=QUOTA_INDEXING_LIMIT, warn_at=QUOTA_INDEXING_WARN_AT)


@with_retry()
def submit_url(url: str, url_type: str = "URL_UPDATED", account: str = "") -> str:
    """Submit a single URL to the Google Indexing API for crawl notification.

    url_type must be 'URL_UPDATED' (page added or changed, default) or 'URL_DELETED' (page removed).
    Requires a service account with Indexing API access — OAuth is not sufficient.
    Returns the full Google API response including urlNotificationMetadata.
    Transient 429/5xx errors are retried automatically (up to 3 times). Credential errors
    and non-retryable failures propagate to the caller.
    """
    svc = get_indexing_service(account=account)
    response = svc.urlNotifications().publish(body={"url": url, "type": url_type}).execute()
    metadata = response.get("urlNotificationMetadata", {})
    latest = metadata.get("latestUpdate", {})
    return json.dumps(with_meta(
        {
            "url": url,
            "type": url_type,
            "status": "submitted",
            "notify_time": latest.get("notifyTime"),
            "latest_update_type": latest.get("type"),
            "first_publishing_time": metadata.get("firstPublishingTime"),
        },
        tool="submit_url",
        params={"url": url, "type": url_type},
    ))


def _make_callback(results: list, url: str):
    def callback(request_id, response, exception):
        if exception:
            results.append({"url": url, "status": "error", "error": str(exception)})
        else:
            metadata = response.get("urlNotificationMetadata", {})
            latest = metadata.get("latestUpdate", {})
            results.append({
                "url": url,
                "status": "submitted",
                "notify_time": latest.get("notifyTime"),
                "latest_update_type": latest.get("type"),
                "first_publishing_time": metadata.get("firstPublishingTime"),
            })
    return callback


@with_retry()
def submit_batch(urls: list[str], url_type: str = "URL_UPDATED", account: str = "") -> str:
    """Submit multiple URLs to the Google Indexing API in HTTP batches of 100.

    Returns per-URL results, total submitted/error counts, and remaining daily quota.
    Daily limit is 200 requests total. A quota_warning is added to the response when
    usage exceeds 180. url_type: 'URL_UPDATED' (default) or 'URL_DELETED'.
    """
    _default_quota.check(len(urls))
    svc = get_indexing_service(account=account)
    results: list[dict] = []

    for chunk_start in range(0, len(urls), _BATCH_SIZE):
        chunk = urls[chunk_start: chunk_start + _BATCH_SIZE]
        batch = svc.new_batch_http_request()
        for url in chunk:
            request = svc.urlNotifications().publish(body={"url": url, "type": url_type})
            batch.add(request, request_id=url, callback=_make_callback(results, url))
        batch.execute()

    _default_quota.consume(len(urls))

    submitted = sum(1 for r in results if r["status"] == "submitted")
    errors = sum(1 for r in results if r["status"] == "error")
    quota_warning = _default_quota.should_warn()

    payload: dict = {
        "total": len(urls),
        "submitted": submitted,
        "errors": errors,
        "quota_remaining": _default_quota.remaining(),
        "results": results,
    }
    if quota_warning:
        payload["quota_warning"] = True

    return json.dumps(with_meta(payload, tool="submit_batch", params={"url_count": len(urls), "type": url_type}))


def indexnow_submit(site: str, key: str, urls: list[str], account: str = "") -> str:
    """Submit URLs to IndexNow, notifying Bing, Yandex, Seznam, and Naver simultaneously.

    IndexNow is an open protocol independent of Google. One POST to api.indexnow.org
    dispatches to all four participating engines. Each URL is validated with
    validate_url_strict (SSRF-safe) before submission. Invalid URLs are skipped and
    counted in skipped_invalid. The key must be 8-128 characters; you are responsible
    for hosting the key file at {site}/{key}.txt.

    Verdicts: ok (all valid, 200/202) | partial (some skipped, 200/202) | error.
    No Google API calls. No Google authentication required.
    """
    valid_urls: list[str] = []
    skipped_invalid = 0
    for u in urls:
        try:
            validate_url_strict(u)
            valid_urls.append(u)
        except URLSafetyError:
            skipped_invalid += 1

    if not valid_urls:
        return json.dumps(with_meta(
            {
                "site": site,
                "submitted": 0,
                "skipped_invalid": skipped_invalid,
                "status_code": None,
                "verdict": "error",
            },
            tool="indexnow_submit",
            params={"site": site, "url_count": len(urls)},
        ))

    parsed = urlparse(site)
    host = parsed.hostname or site
    key_location = f"{site.rstrip('/')}/{key}.txt"

    payload = {
        "host": host,
        "key": key,
        "keyLocation": key_location,
        "urlList": valid_urls,
    }

    try:
        with httpx.Client(timeout=15) as client:
            resp = client.post(
                _INDEXNOW_ENDPOINT,
                json=payload,
                headers={"Content-Type": "application/json; charset=utf-8"},
            )
    except httpx.HTTPError as exc:
        return json.dumps(with_meta(
            {
                "site": site,
                "submitted": 0,
                "skipped_invalid": skipped_invalid,
                "status_code": None,
                "error": str(exc),
                "verdict": "error",
            },
            tool="indexnow_submit",
            params={"site": site, "url_count": len(urls)},
        ))

    status = resp.status_code
    if status in (200, 202):
        verdict = "ok" if skipped_invalid == 0 else "partial"
    else:
        verdict = "error"

    return json.dumps(with_meta(
        {
            "site": site,
            "submitted": len(valid_urls),
            "skipped_invalid": skipped_invalid,
            "status_code": status,
            "verdict": verdict,
        },
        tool="indexnow_submit",
        params={"site": site, "url_count": len(urls)},
    ))


# ---------------------------------------------------------------------------
# submit_sitemap_urls — fetch sitemap, parse URLs, submit all for indexing
# ---------------------------------------------------------------------------

_NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}


def _parse_sitemap_urls(sitemap_url: str) -> list[str]:
    """Fetch and parse a sitemap (regular or index) into a flat URL list."""
    from urllib.parse import urlparse as _urlparse
    origin = _urlparse(sitemap_url).netloc

    def _fetch(url: str) -> ET.Element | None:
        if _urlparse(url).netloc != origin:
            return None
        try:
            validate_url_strict(url)
        except Exception:
            return None
        try:
            with httpx.Client(timeout=15, follow_redirects=False) as client:
                resp = client.get(url, headers={"User-Agent": "gsc-mcp-sitemap-urls/1.0"})
                resp.raise_for_status()
                return ET.fromstring(resp.content)
        except (httpx.HTTPError, ET.ParseError, DefusedXmlException):
            return None

    root = _fetch(sitemap_url)
    if root is None:
        return []

    urls: list[str] = []

    if root.tag.endswith("sitemapindex"):
        for loc in root.findall(".//sm:sitemap/sm:loc", _NS):
            child_url = loc.text.strip() if loc.text else ""
            if child_url:
                child = _fetch(child_url)
                if child is not None:
                    urls += [
                        l.text.strip()
                        for l in child.findall(".//sm:url/sm:loc", _NS)
                        if l.text
                    ]
    else:
        urls = [
            l.text.strip()
            for l in root.findall(".//sm:url/sm:loc", _NS)
            if l.text
        ]

    return urls


def submit_sitemap_urls(site: str, sitemap_url: str, url_filter: str = "", account: str = "") -> str:
    """Fetch a sitemap, parse all URLs, and submit them to the Google Indexing API for crawl notification.

    url_filter is an optional substring filter — only URLs containing it are submitted.
    For example, url_filter="/blog/" submits only blog post URLs.

    Requires the Indexing API to be enabled in the GCP project. Daily limit: 200 requests.
    Returns submitted count, errors, and remaining quota.
    """
    urls = _parse_sitemap_urls(sitemap_url)
    if not urls:
        return json.dumps(with_meta(
            {"site": site, "sitemap_url": sitemap_url, "total_parsed": 0, "submitted": 0,
             "error": "No URLs found in sitemap (fetch failed or empty)"},
            tool="submit_sitemap_urls",
            params={"site": site, "sitemap_url": sitemap_url, "url_filter": url_filter},
        ))

    if url_filter:
        urls = [u for u in urls if url_filter in u]

    # Deduplicate and normalize
    urls = list(dict.fromkeys(urls))

    if not urls:
        return json.dumps(with_meta(
            {"site": site, "sitemap_url": sitemap_url, "total_parsed": len(_parse_sitemap_urls(sitemap_url)),
             "submitted": 0, "error": f"No URLs matched filter '{url_filter}'"},
            tool="submit_sitemap_urls",
            params={"site": site, "sitemap_url": sitemap_url, "url_filter": url_filter},
        ))

    _default_quota.check(len(urls))
    svc = get_indexing_service(account=account)
    results: list[dict] = []

    for chunk_start in range(0, len(urls), _BATCH_SIZE):
        chunk = urls[chunk_start: chunk_start + _BATCH_SIZE]
        batch = svc.new_batch_http_request()
        for url in chunk:
            request = svc.urlNotifications().publish(body={"url": url, "type": "URL_UPDATED"})
            batch.add(request, request_id=url, callback=_make_callback(results, url))
        batch.execute()

    _default_quota.consume(len(urls))

    submitted = sum(1 for r in results if r["status"] == "submitted")
    errors = sum(1 for r in results if r["status"] == "error")

    return json.dumps(with_meta(
        {
            "site": site,
            "sitemap_url": sitemap_url,
            "total_parsed": len(_parse_sitemap_urls(sitemap_url)),
            "filtered_to": len(urls),
            "submitted": submitted,
            "errors": errors,
            "quota_remaining": _default_quota.remaining(),
            "results": results,
        },
        tool="submit_sitemap_urls",
        params={"site": site, "sitemap_url": sitemap_url, "url_filter": url_filter},
    ))


# ---------------------------------------------------------------------------
# force_reindex — inspect URLs against GSC, auto-submit any not indexed
# ---------------------------------------------------------------------------

def force_reindex(site: str, urls: list[str] | None = None, sitemap_url: str = "",
                  url_filter: str = "", account: str = "") -> str:
    """Inspect URLs against GSC and auto-submit any that aren't indexed for crawl.

    Provide EITHER urls (explicit list) OR sitemap_url (auto-fetch all URLs from sitemap).
    url_filter narrows sitemap URLs to those containing the substring (e.g. "/blog/").

    For each URL: inspects GSC → if verdict != PASS, submits to Indexing API.
    Returns per-URL status (already_indexed, submitted, inspect_error) and summary counts.
    Requires the Indexing API to be enabled in the GCP project.
    """
    if urls is None and not sitemap_url:
        return json.dumps(with_meta(
            {"error": "Provide either urls or sitemap_url"},
            tool="force_reindex",
            params={},
        ))

    if urls is None:
        urls = _parse_sitemap_urls(sitemap_url)
        if url_filter:
            urls = [u for u in urls if url_filter in u]
        urls = list(dict.fromkeys(urls))

    if not urls:
        return json.dumps(with_meta(
            {"site": site, "total": 0, "submitted": 0, "already_indexed": 0,
             "error": "No URLs to process"},
            tool="force_reindex",
            params={"site": site, "sitemap_url": sitemap_url, "url_filter": url_filter},
        ))

    svc_gsc = get_searchconsole_service(account=account)
    svc_indexing = get_indexing_service(account=account)

    results: list[dict] = []
    to_submit: list[str] = []

    for url in urls:
        try:
            response = svc_gsc.urlInspection().index().inspect(
                body={"inspectionUrl": url, "siteUrl": site}
            ).execute()
            parsed = _parse_inspection(url, response)
            verdict = parsed["verdict"]
            category = parsed["category"]
        except Exception as exc:
            parsed = {"url": url, "verdict": "ERROR", "error": str(exc), "category": "inspect_error"}
            verdict = "ERROR"
            category = "inspect_error"

        results.append(parsed)
        if category not in ("indexed",):
            to_submit.append(url)

    # Submit non-indexed URLs
    submit_results: list[dict] = []
    if to_submit:
        _default_quota.check(len(to_submit))
        for chunk_start in range(0, len(to_submit), _BATCH_SIZE):
            chunk = to_submit[chunk_start: chunk_start + _BATCH_SIZE]
            batch = svc_indexing.new_batch_http_request()
            for url in chunk:
                request = svc_indexing.urlNotifications().publish(body={"url": url, "type": "URL_UPDATED"})
                batch.add(request, request_id=url, callback=_make_callback(submit_results, url))
            batch.execute()
        _default_quota.consume(len(to_submit))

    already_indexed = sum(1 for r in results if r["category"] == "indexed")
    submitted = sum(1 for r in submit_results if r["status"] == "submitted")
    inspect_errors = sum(1 for r in results if r["category"] == "inspect_error")
    submit_errors = sum(1 for r in submit_results if r["status"] == "error")

    return json.dumps(with_meta(
        {
            "site": site,
            "total": len(urls),
            "already_indexed": already_indexed,
            "not_indexed": len(to_submit),
            "submitted": submitted,
            "inspect_errors": inspect_errors,
            "submit_errors": submit_errors,
            "quota_remaining": _default_quota.remaining(),
            "results": results,
            "submit_results": submit_results,
        },
        tool="force_reindex",
        params={"site": site, "url_count": len(urls), "sitemap_url": sitemap_url,
                "url_filter": url_filter},
    ))
