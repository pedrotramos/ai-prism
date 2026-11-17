#!/usr/bin/env bash
# Decides whether CI checks that the committed client/dist and server-dist match
# the build. Prints "check" or "skip" (one word on stdout).
#
# Rule: feature PRs do NOT commit client/dist or server-dist. Their file names
# are content-hashed, so any two client PRs would conflict there by
# construction. The artifacts are rebuilt and committed only in release PRs:
# head branch release/* or the label "release". Pushes to main skip too,
# because a merged feature PR leaves dist stale by design until the next release.
#
# Inputs (environment, as the workflow passes them; never interpolated into code):
#   EVENT_NAME  github.event_name
#   HEAD_REF    github.head_ref (PR source branch; empty on push)
#   PR_LABELS   toJSON(github.event.pull_request.labels.*.name), e.g. ["release"]
#
#   EVENT_NAME=pull_request HEAD_REF=release/1.5.0 PR_LABELS='[]' bash tests/ci/dist-drift-mode.sh   # → check
# Tested by tests/distDriftMode.test.mjs.
set -euo pipefail

mode=skip
if [ "${EVENT_NAME:-}" = "pull_request" ]; then
  case "${HEAD_REF:-}" in
    release/*) mode=check ;;
  esac
  # exact label match: the quotes keep "release-notes" or "pre-release" out
  if printf '%s' "${PR_LABELS:-[]}" | grep -qF '"release"'; then
    mode=check
  fi
fi
echo "$mode"
