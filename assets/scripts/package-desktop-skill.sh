#!/usr/bin/env bash
# Package the Claude Desktop skills as importable .skill files.
# Usage: bash scripts/package-desktop-skill.sh
# Outputs: meko-mcp-tools-desktop.skill and meko-select-datapack-desktop.skill

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_ROOT="${MEKO_DESKTOP_SKILLS_ROOT:-$SCRIPT_DIR/../skills}"
SKILL_NAMES=("meko-mcp-tools-desktop" "meko-select-datapack-desktop")
XML_TAG_PATTERN='</?[[:alpha:]_:][[:alnum:]_.:-]*([[:blank:]][^<>]*)?[[:blank:]]*/?>'

for SKILL_NAME in "${SKILL_NAMES[@]}"; do
    if [ ! -d "$SKILLS_ROOT/$SKILL_NAME" ]; then
        echo "Error: Skill directory not found at $SKILLS_ROOT/$SKILL_NAME" >&2
        exit 1
    fi

    if [ ! -f "$SKILLS_ROOT/$SKILL_NAME/SKILL.md" ]; then
        echo "Error: SKILL.md not found in $SKILLS_ROOT/$SKILL_NAME/" >&2
        exit 1
    fi

    if ! grep -q '^description:[[:space:]]*' "$SKILLS_ROOT/$SKILL_NAME/SKILL.md"; then
        echo "Error: SKILL.md description is missing: $SKILL_NAME" >&2
        exit 1
    fi

    DESCRIPTION="$(awk '
        /^description:[[:space:]]*/ {
            in_description = 1
            value = $0
            sub(/^description:[[:space:]]*/, "", value)
            if (value !~ /^[>|][+-]?$/) printf "%s ", value
            next
        }
        in_description && /^[^[:space:]]/ { exit }
        in_description {
            sub(/^[[:space:]]+/, "")
            printf "%s ", $0
        }
    ' "$SKILLS_ROOT/$SKILL_NAME/SKILL.md")"

    if [[ -z "${DESCRIPTION//[[:space:]]/}" ]]; then
        echo "Error: SKILL.md description is empty: $SKILL_NAME" >&2
        exit 1
    fi

    if printf '%s\n' "$DESCRIPTION" | grep -Eq "$XML_TAG_PATTERN"; then
        echo "Error: SKILL.md description cannot contain XML-like tags: $SKILL_NAME" >&2
        exit 1
    fi
done

for SKILL_NAME in "${SKILL_NAMES[@]}"; do
    OUTPUT="$SCRIPT_DIR/../$SKILL_NAME.skill"
    rm -f "$OUTPUT"

    # Package skill + references (exclude OS artifacts and desktop README)
    cd "$SKILLS_ROOT"
    zip -r "$OUTPUT" \
        "$SKILL_NAME/SKILL.md" \
        "$SKILL_NAME/references/" \
        -x "*.DS_Store" "*__pycache__*"

    echo "Created $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
    echo ""
    echo "Contents:"
    unzip -l "$OUTPUT" | grep -E "^\s+[0-9]" | grep -v "files$"
done
