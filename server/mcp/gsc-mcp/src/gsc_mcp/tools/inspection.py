import json
from gsc_mcp.auth import get_searchconsole_service
from gsc_mcp.meta import with_meta
from gsc_mcp.retry import with_retry

_MAX_BATCH = 10


def _categorize(result: dict) -> str:
    """Categorize URL based on full Google inspection data.

    Uses coverageState for nuanced status beyond simple verdict.
    """
    verdict = result.get("verdict", "")
    robots = result.get("robotsTxtState", "")
    fetch = result.get("pageFetchState", "")
    coverage = result.get("coverageState", "")
    google_canonical = result.get("googleCanonical", "")
    user_canonical = result.get("userCanonical", "")

    if verdict == "PASS":
        return "indexed"
    if "BLOCKED_BY_ROBOTS_TXT" in robots:
        return "robots_blocked"
    if fetch not in ("", "SUCCESSFUL", "PAGE_FETCH_STATE_UNSPECIFIED"):
        return "fetch_error"
    if google_canonical and user_canonical and google_canonical != user_canonical:
        return "canonical_issue"
    if "unknown to Google" in coverage:
        return "unknown"
    if "Discovered - currently not indexed" in coverage:
        return "discovered_not_indexed"
    if "Crawled - currently not indexed" in coverage:
        return "crawled_not_indexed"
    if "Duplicate" in coverage:
        return "duplicate"
    if "Excluded" in coverage:
        return "excluded"
    return "not_indexed"


def _parse_inspection(url: str, response: dict) -> dict:
    """Extract ALL fields from Google URL Inspection API response.

    Response structure:
    - inspectionResult.inspectionResultLink (GSC web UI link)
    - inspectionResult.indexStatusResult: verdict, coverageState, robotsTxtState,
      indexingState, lastCrawlTime, pageFetchState, googleCanonical, userCanonical,
      sitemap[], referringUrls[], crawledAs
    - inspectionResult.mobileUsabilityResult: verdict
    """
    inspection = response.get("inspectionResult", {})
    index_result = inspection.get("indexStatusResult", {})
    mobile_result = inspection.get("mobileUsabilityResult", {})

    return {
        "url": url,
        "verdict": index_result.get("verdict", "UNKNOWN"),
        "coverage_state": index_result.get("coverageState", "UNKNOWN"),
        "robots_txt_state": index_result.get("robotsTxtState", "UNKNOWN"),
        "indexing_state": index_result.get("indexingState", "UNKNOWN"),
        "last_crawl": index_result.get("lastCrawlTime"),
        "page_fetch_state": index_result.get("pageFetchState"),
        "google_canonical": index_result.get("googleCanonical"),
        "user_canonical": index_result.get("userCanonical"),
        "sitemap": index_result.get("sitemap", []),
        "referring_urls": index_result.get("referringUrls", []),
        "crawled_as": index_result.get("crawledAs", "UNKNOWN"),
        "mobile_verdict": mobile_result.get("verdict", "UNKNOWN"),
        "gsc_inspection_link": inspection.get("inspectionResultLink"),
        "category": _categorize(index_result),
    }


@with_retry()
def inspect_url(url: str, site: str, account: str = "") -> str:
    """Inspect a single URL in GSC to get its indexing status, last crawl time, and canonical URL.

    Returns verdict (PASS/NEUTRAL/FAIL), robotsTxtState, indexingState, pageFetchState,
    googleCanonical, userCanonical, and a derived category (indexed, robots_blocked,
    fetch_error, canonical_issue, not_indexed).
    """
    svc = get_searchconsole_service(account=account)
    body = {"inspectionUrl": url, "siteUrl": site}
    response = svc.urlInspection().index().inspect(body=body).execute()
    parsed = _parse_inspection(url, response)
    return json.dumps(with_meta(parsed, tool="inspect_url", params={"url": url, "site": site}))


@with_retry()
def _inspect_one_url(svc, site: str, url: str) -> dict:
    response = svc.urlInspection().index().inspect(
        body={"inspectionUrl": url, "siteUrl": site}
    ).execute()
    return _parse_inspection(url, response)


def batch_url_inspection(urls: list[str], site: str, account: str = "") -> str:
    """Inspect up to 10 URLs at once in GSC. Returns the same fields as inspect_url for each URL."""
    if len(urls) > _MAX_BATCH:
        raise ValueError(f"batch_url_inspection supports max 10 URLs, got {len(urls)}")

    svc = get_searchconsole_service(account=account)
    results = [_inspect_one_url(svc, site, url) for url in urls]

    return json.dumps(with_meta(
        {"site": site, "count": len(results), "results": results},
        tool="batch_url_inspection",
        params={"site": site, "url_count": len(urls)},
    ))


def check_indexing_issues(urls: list[str], site: str, account: str = "") -> str:
    """Inspect up to 10 URLs and return only those with indexing problems, plus a summary count by category.

    Categories: indexed, not_indexed, robots_blocked, fetch_error, canonical_issue.
    Use batch_url_inspection if you need results for all URLs regardless of status.
    """
    if len(urls) > _MAX_BATCH:
        raise ValueError(f"check_indexing_issues supports max 10 URLs, got {len(urls)}")

    svc = get_searchconsole_service(account=account)
    issues = []
    summary: dict[str, int] = {
        "indexed": 0,
        "not_indexed": 0,
        "unknown": 0,
        "discovered_not_indexed": 0,
        "crawled_not_indexed": 0,
        "duplicate": 0,
        "excluded": 0,
        "robots_blocked": 0,
        "fetch_error": 0,
        "canonical_issue": 0,
    }

    for url in urls:
        parsed = _inspect_one_url(svc, site, url)
        summary[parsed["category"]] = summary.get(parsed["category"], 0) + 1
        if parsed["category"] != "indexed":
            issues.append(parsed)

    return json.dumps(with_meta(
        {"site": site, "summary": summary, "issues": issues},
        tool="check_indexing_issues",
        params={"site": site, "url_count": len(urls)},
    ))
