#!/usr/bin/env bash
# generate_release_notes.sh
# Usage: generate_release_notes.sh [VERSION]
#   VERSION  – the tag to extract, e.g. "v1.2.3"
#              Falls back to the GITHUB_REF_NAME environment variable.
#
# Reads CHANGELOG.md from the repository root (script must be run from there
# or pass a different path as the second argument) and writes the matching
# section to release_notes.md.
set -euo pipefail

# ── 1. Resolve the version ────────────────────────────────────────────────────
VERSION="${1:-${GITHUB_REF_NAME:-}}"
VERSION="${VERSION#refs/tags/}"   # strip refs/tags/ prefix when present

if [[ -z "$VERSION" ]]; then
  echo "ERROR: No version provided." \
       "Pass it as the first argument or set GITHUB_REF_NAME." >&2
  exit 1
fi

CHANGELOG="${2:-CHANGELOG.md}"
OUTPUT="release_notes.md"

echo "Extracting release notes for '${VERSION}' from '${CHANGELOG}' …"

if [[ ! -f "$CHANGELOG" ]]; then
  echo "ERROR: ${CHANGELOG} not found. Run this script from the repository root." >&2
  exit 1
fi

# ── 2. Extract the matching section ──────────────────────────────────────────
# CHANGELOG headings look like:   ## v1.2.3 - 2024-06-01
# We match "## <VERSION>" with anything (space, dash, end-of-line) after it,
# then collect all lines until the next level-2 heading or end of file.
changelog_section=$(
  awk \
    -v ver="$VERSION" \
    'BEGIN { flag = 0 }
     # Start capturing after the heading line that matches this version
     $0 ~ ("^## " ver "([[:space:]]|$)") { flag = 1; next }
     # Stop capturing when the next ## heading is encountered
     /^## /                               { flag = 0 }
     flag                                 { print }' \
    "$CHANGELOG"
)

# ── 3. Trim leading and trailing blank lines ──────────────────────────────────
changelog_section=$(printf '%s' "$changelog_section" \
  | sed -e '/[^[:space:]]/,$!d' \
  | sed -e ':loop' -e '/^[[:space:]]*$/{$d;N;b loop}')

# ── 4. Fallback when no matching section was found ───────────────────────────
if [[ -z "$changelog_section" ]]; then
  echo "WARNING: No '## ${VERSION}' section found in ${CHANGELOG}. Using fallback." >&2
  changelog_section="No changelog entry found for ${VERSION}. See [CHANGELOG.md](./CHANGELOG.md) for details."
fi

# ── 5. Write output ───────────────────────────────────────────────────────────
printf '%s\n' "$changelog_section" > "$OUTPUT"

echo "Release notes written to ${OUTPUT}:"
echo "────────────────────────────────────"
cat "$OUTPUT"
echo "────────────────────────────────────"
