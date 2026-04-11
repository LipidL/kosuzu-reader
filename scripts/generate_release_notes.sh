#!/bin/bash
set -e

# Get latest tag
latest_tag=$(git describe --tags --abbrev=0)

# Extract changelog section for latest tag
changelog_section=$(awk "/^## $latest_tag/{flag=1;next}/^## /{flag=0}flag" CHANGELOG.md)

# Compose release note
cat <<EOF > release_note.md
$changelog_section
EOF

echo "Release note generated in release_note.md"
