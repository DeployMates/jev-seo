"""
GSC MCP authentication module.
Multi-site support: pass account="mirorpay" or account="bene2luxe" to any service function.
"""

import json
import os
import urllib.parse
from pathlib import Path

import requests
from google.oauth2 import service_account
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from google.auth.transport.requests import Request
from platformdirs import user_data_dir

from google.analytics.data_v1alpha import AlphaAnalyticsDataClient
from google.analytics.data_v1beta import BetaAnalyticsDataClient

from gsc_mcp.constants import SCOPES_GSC, SCOPES_INDEXING, SCOPES_GA4

_TOKEN_DIR = Path(user_data_dir("gsc-mcp"))
_TOKEN_GSC = _TOKEN_DIR / "token_gsc.json"
_TOKEN_INDEXING = _TOKEN_DIR / "token_indexing.json"

_SITES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sites.json")


def _load_sites() -> list[dict]:
    """Load all sites from sites.json.

    If GSC_SERVICE_ACCOUNT_PATH env var is set, returns [] (legacy mode).
    If sites.json does not exist or has no entries, returns [].
    """
    # Legacy mode: env var takes precedence
    env_path = os.environ.get("GSC_SERVICE_ACCOUNT_PATH", "")
    if env_path:
        return []

    if os.path.exists(_SITES_FILE):
        with open(_SITES_FILE) as f:
            data = json.load(f)
        sites = data.get("sites", [])
        if sites:
            return sites

    return []


_SITES = _load_sites()


def _get_default_site() -> dict | None:
    """Return the first site in the list (default)."""
    if not _SITES:
        return None
    return _SITES[0]


def _resolve_site(account: str = "") -> dict | None:
    """Return site dict by name. Empty string → use default.

    Returns None if no sites are configured (legacy env-var mode).
    Raises ValueError if account name is not found.
    """
    if not _SITES:
        return None  # legacy mode — no sites.json

    if not account:
        default = _get_default_site()
        if default:
            return default
        raise ValueError("No sites configured in sites.json")

    for s in _SITES:
        if s["name"] == account:
            return s

    valid = [s["name"] for s in _SITES]
    raise ValueError(f"Unknown site '{account}'. Valid sites: {valid}")


def _load_oauth_token(token_path: Path) -> Credentials | None:
    if not token_path.exists():
        return None
    data = json.loads(token_path.read_text())
    return Credentials.from_authorized_user_info(data)


def _save_oauth_token(token_path: Path, creds: Credentials) -> None:
    token_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(creds.to_json())


def _get_service_account_creds(
    scopes: list[str],
    credentials_path: str | None = None,
) -> service_account.Credentials:
    """Create service account credentials from a path (or GSC_SERVICE_ACCOUNT_PATH env var)."""
    sa_path = credentials_path or os.environ.get("GSC_SERVICE_ACCOUNT_PATH", "")
    if not sa_path or not Path(sa_path).exists():
        raise RuntimeError(
            f"No credentials: path not found: {sa_path!r}"
        )
    return service_account.Credentials.from_service_account_file(sa_path, scopes=scopes)


def _get_oauth_creds(scopes: list[str], token_path: Path) -> Credentials:
    creds = _load_oauth_token(token_path)

    if creds and creds.valid:
        return creds

    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        _save_oauth_token(token_path, creds)
        return creds

    credentials_path = os.environ.get("GSC_CREDENTIALS_PATH", "")
    if not credentials_path or not Path(credentials_path).exists():
        raise RuntimeError(
            f"No credentials: GSC_CREDENTIALS_PATH not set or file not found: {credentials_path!r}"
        )

    flow = InstalledAppFlow.from_client_secrets_file(credentials_path, scopes)
    if os.environ.get("GSC_NO_BROWSER", "").lower() in ("1", "true", "yes"):
        raise RuntimeError(
            "OAuth browser flow disabled (GSC_NO_BROWSER). "
            "Set GSC_SERVICE_ACCOUNT_PATH, or run `gsc-cli auth login` interactively."
        )
    creds = flow.run_local_server(port=0)
    _save_oauth_token(token_path, creds)
    return creds


def _resolve_creds(scopes: list[str], token_path: Path):
    """Legacy credential resolver (env-var based). Used when sites.json is not configured."""
    skip_oauth = os.environ.get("GSC_SKIP_OAUTH", "false").lower() in ("1", "true", "yes")
    sa_path = os.environ.get("GSC_SERVICE_ACCOUNT_PATH", "")

    if sa_path:
        return _get_service_account_creds(scopes)

    if skip_oauth:
        raise RuntimeError(
            "No credentials: GSC_SKIP_OAUTH=true but GSC_SERVICE_ACCOUNT_PATH is not set"
        )

    return _get_oauth_creds(scopes, token_path)


class GSCResponse:
    """Mimics httplib2.Response for backward compat with HttpError consumers."""
    def __init__(self, status: int):
        self.status = status


class GSCError(RuntimeError):
    """Replacement for googleapiclient.errors.HttpError.

    Preserves .resp.status for compatibility with retry.py and analytics.py.
    """
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.resp = GSCResponse(status)
        self.status_code = status
        self.reason = message


_GSC_BASE = "https://searchconsole.googleapis.com/webmasters/v3"


_URL_PATTERNS = {
    # (resource, *path_segments) → (http_method, url_template, body_kwarg)
    ("searchanalytics", "query"): ("POST", "/sites/{siteUrl}/searchAnalytics/query", "body"),
    ("sitemaps", "list"): ("GET", "/sites/{siteUrl}/sitemaps", None),
    ("sitemaps", "get"): ("GET", "/sites/{siteUrl}/sitemaps/{feedpath}", None),
    ("sitemaps", "submit"): ("PUT", "/sites/{siteUrl}/sitemaps/{feedpath}", None),
    ("sitemaps", "delete"): ("DELETE", "/sites/{siteUrl}/sitemaps/{feedpath}", None),
    ("sites", "list"): ("GET", "/sites", None),
    ("sites", "get"): ("GET", "/sites/{siteUrl}", None),
    ("urlInspection", "index", "inspect"): ("POST", "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", "body"),
}


class _GSCRequest:
    def __init__(self, token: str, path: list[str], kwargs: dict | None = None):
        self._token = token
        self._path = list(path)
        self._kwargs = kwargs or {}
        self._body: dict | None = None

    def execute(self):
        path_key = tuple(self._path)
        if path_key not in _URL_PATTERNS:
            raise RuntimeError(f"Unknown GSC API endpoint: {'/'.join(self._path)}")

        http_method, url_tpl, body_kw = _URL_PATTERNS[path_key]
        # URL-encode path parameters (all kwargs except body_kw)
        encoded = {
            k: urllib.parse.quote(str(v), safe="") if k != body_kw else v
            for k, v in self._kwargs.items()
        }
        formatted = url_tpl.format(**encoded)
        url = formatted if formatted.startswith("http") else f"{_GSC_BASE}{formatted}"
        body = self._kwargs.get(body_kw) if body_kw else self._body or None

        headers = {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
        }

        if http_method == "GET":
            resp = requests.get(url, headers=headers, timeout=30)
        elif http_method == "DELETE":
            resp = requests.delete(url, headers=headers, timeout=30)
        elif http_method == "PUT":
            resp = requests.put(url, headers=headers, json=body or {}, timeout=30)
        else:
            resp = requests.post(url, headers=headers, json=body or {}, timeout=30)

        if resp.status_code >= 400:
            raise GSCError(resp.status_code, resp.text[:500])
        if not resp.content:
            return {}
        return resp.json()

    def execute_next(self, request_body: dict):
        self._body = request_body
        return self.execute()

    def __getattr__(self, name: str) -> "_GSCRequest":
        if name == "execute":
            raise AttributeError(name)
        return _GSCRequest(self._token, self._path + [name], self._kwargs)

    def __call__(self, **kwargs) -> "_GSCRequest":
        self._kwargs.update(kwargs)
        return self


class _GSCService:
    def __init__(self, token: str):
        self._token = token

    def __getattr__(self, name: str) -> "_GSCRequest":
        return _GSCRequest(self._token, [name])

    def __call__(self, **kwargs):
        return _GSCRequest(self._token, [], kwargs)


def _get_token(creds) -> str:
    if not creds.valid:
        creds.refresh(Request())
    return creds.token


def get_searchconsole_service(account: str = ""):
    site = _resolve_site(account)
    if site:
        creds = _get_service_account_creds(SCOPES_GSC, site["credentials_path"])
    else:
        creds = _resolve_creds(SCOPES_GSC, _TOKEN_GSC)
    token = _get_token(creds)
    return _GSCService(token)


def get_indexing_service(account: str = ""):
    """Build a Google Indexing API service (multi-site aware)."""
    site = _resolve_site(account)
    if site:
        creds = _get_service_account_creds(SCOPES_INDEXING, site["credentials_path"])
    else:
        creds = _resolve_creds(SCOPES_INDEXING, _TOKEN_INDEXING)
    return build("indexing", "v3", credentials=creds)


_TOKEN_GA4 = _TOKEN_DIR / "token_ga4.json"


def get_ga4_property_id(account: str = "", override: str | None = None) -> str:
    """Resolve the GA4 property ID.

    Priority:
    1. `override` parameter (explicit override)
    2. sites.json entry for the given account
    3. GA4_PROPERTY_ID env var (legacy mode)

    Returns the ID prefixed with 'properties/' if not already.
    """
    if override:
        prop = override.strip()
    else:
        site = _resolve_site(account)
        if site:
            prop = site.get("ga4_property_id", "").strip()
        else:
            prop = os.environ.get("GA4_PROPERTY_ID", "").strip()
        if not prop:
            raise RuntimeError(
                "No GA4 config: GA4_PROPERTY_ID environment variable is not set "
                "and no ga4_property_id in sites.json"
            )
    return prop if prop.startswith("properties/") else f"properties/{prop}"


def _ga4_creds(account: str = ""):
    """Resolve GA4 credentials for the given account."""
    site = _resolve_site(account)
    if site:
        return _get_service_account_creds(SCOPES_GA4, site["credentials_path"])
    return _resolve_creds(SCOPES_GA4, _TOKEN_GA4)


def get_ga4_service(account: str = "") -> BetaAnalyticsDataClient:
    """Build a GA4 BetaAnalyticsDataClient (multi-site aware)."""
    return BetaAnalyticsDataClient(credentials=_ga4_creds(account))


def get_alpha_ga4_service(account: str = "") -> AlphaAnalyticsDataClient:
    """Build a GA4 AlphaAnalyticsDataClient (multi-site aware)."""
    return AlphaAnalyticsDataClient(credentials=_ga4_creds(account))
