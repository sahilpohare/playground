#!/usr/bin/env bash
exec bun --no-env-file packages/scripts/src/commit-trailer.ts --push "$1"
