#!/usr/bin/env bash
# Build the npm variant of README.md.
#
# npm renders a published README with no access to the repository, so two things
# that work on GitHub break there:
#
# - **Relative asset paths.** `.assets/banner.png` resolves against the GitHub
#   repo, not against the package. The `files` allowlist ships no `.assets/`, and
#   adding it would not help: npm does not serve files out of the tarball by path.
#   The images are published on the project's own domain instead, so those become
#   absolute URLs.
# - **The title.** The npm page shows "Jev MotherF*Cker Rank Me" if the README
#   says so, and the maintainer wants "JEV-SEO" there while the repository keeps
#   the other. One source, two renderings — hence a generated file rather than a
#   second README that drifts.
#
# Writes to stdout. `publish.sh` swaps it in and restores the original.
set -euo pipefail

cd "$(dirname "$0")"

ASSET_BASE="${JEV_ASSET_BASE:-https://jev.mfrank.me}"
NPM_TITLE="${JEV_NPM_TITLE:-JEV-SEO}"

# `.assets/x` -> absolute URL. Only the leading folder is rewritten, so links
# into docs/ stay relative and are not silently pointed at the live site.
sed \
  -e "s#src=\".assets/#src=\"${ASSET_BASE}/#g" \
  -e "s#href=\".assets/#href=\"${ASSET_BASE}/#g" \
  -e "s#](.assets/#](${ASSET_BASE}/#g" \
  -e "s#\[\`.assets/#[\`${ASSET_BASE}/#g" \
  -e "s#Jev MotherF\\\\\*Cker Rank Me#${NPM_TITLE}#g" \
  README.md
