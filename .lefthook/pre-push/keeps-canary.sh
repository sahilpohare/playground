#!/usr/bin/env bash
exec bun --no-env-file packages/scripts/src/pr-merge/prepush.ts
