#!/usr/bin/env bash
# Launcher for the vendored GSC MCP server.
#
# Prefers the copy that lives in this repo (server/mcp/gsc-mcp/src) so the
# project is self-contained and the server code is versioned and editable with
# it. Falls back to a `gsc-mcp` already on PATH when uv is unavailable.
#
# The service account path is resolved relative to this script, never from an
# environment variable pointing somewhere else, so a stray GSC_SERVICE_ACCOUNT_PATH
# in the shell cannot redirect the MCP at another key.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"

export PYTHONPATH="$here/src${PYTHONPATH:+:$PYTHONPATH}"
export GSC_SERVICE_ACCOUNT_PATH="${GSC_SERVICE_ACCOUNT_PATH:-$repo_root/.gsc/service-account.json}"
export GSC_SKIP_OAUTH="${GSC_SKIP_OAUTH:-true}"

if command -v uv >/dev/null 2>&1; then
  exec uv run --quiet --no-project \
    --with "mcp[cli]<2" \
    --with google-api-python-client \
    --with google-analytics-data \
    --with google-auth \
    --with google-auth-oauthlib \
    --with requests \
    --with httpx \
    --with defusedxml \
    --with platformdirs \
    python -m gsc_mcp.server
fi

if command -v gsc-mcp >/dev/null 2>&1; then
  exec gsc-mcp
fi

echo "gsc-mcp: neither uv nor gsc-mcp is available on PATH" >&2
exit 1
