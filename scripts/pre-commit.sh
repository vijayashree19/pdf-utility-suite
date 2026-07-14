#!/usr/bin/env bash
# Pre-commit guard: type-check + full test suite must pass before committing.
# Install with: ln -sf ../../scripts/pre-commit.sh .git/hooks/pre-commit
set -e

echo "Running TypeScript type-check..."
npx tsc --noEmit

echo "Running test suite..."
npx vitest run

echo "✅ Pre-commit checks passed."
