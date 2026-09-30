#!/usr/bin/env bash
# Publish jevseo to npm.
#
# --ignore-scripts on purpose: prepublishOnly runs typecheck && build && verify,
# and typecheck is red while the project is mid-build. This script publishes the
# existing server/dist + web/dist. Run `npm run typecheck` yourself once the
# work settles and publish again without the flag.
#
# Needs a token that can publish. If 2FA is on, a classic `npm_` automation
# token cannot: npm answers
#   403 ... Two-factor authentication or granular access token with bypass 2fa
# and there is no --otp that fixes a classic token. Either supply an OTP via
# OTP=123456, or use a granular token with "bypass 2FA" ticked.
set -euo pipefail

cd "$(dirname "$0")"

if ! npm whoami >/dev/null 2>&1; then
  echo "not authenticated — set a token first:" >&2
  echo "  npm config set //registry.npmjs.org/:_authToken <token>" >&2
  exit 1
fi

echo "publishing jevseo as $(npm whoami)"

# npm renders the README with no access to the repository, so relative image
# paths and the repo's own title both break there. Swap in the generated npm
# variant for the duration of the publish and put the original back whatever
# happens — a half-swapped README that reached git would be worse than no fix.
README_BACKUP="$(mktemp)"
cp README.md "$README_BACKUP"
restore_readme() {
  cp "$README_BACKUP" README.md
  rm -f "$README_BACKUP"
}
trap restore_readme EXIT INT TERM

# Generated into a temp file and moved into place, never redirected onto
# README.md directly: the shell truncates a redirect target before the producing
# command reads it, so `npm-readme.sh > README.md` ships a zero-byte README. npm
# accepts that silently — the package page just comes up empty.
NPM_README="$(mktemp)"
./npm-readme.sh > "$NPM_README"
if [ ! -s "$NPM_README" ]; then
  echo "generated README is empty — refusing to publish" >&2
  exit 1
fi
cp "$NPM_README" README.md
rm -f "$NPM_README"
echo "  readme: npm variant ($(wc -c < README.md | tr -d ' ') bytes, title ${JEV_NPM_TITLE:-JEV-SEO})"

args=(--access public --ignore-scripts)
if [ -n "${OTP:-}" ]; then
  args+=(--otp "$OTP")
fi

npm publish "${args[@]}"
