#!/bin/bash
set -euo pipefail
trap 'echo -e "\n\033[0;31m  ✗ Release failed at line $LINENO (exit code $?)\033[0m"' ERR

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

step() { echo -e "\n${CYAN}=== [$1/$TOTAL_STEPS] $2 ===${NC}"; }
info() { echo -e "${GREEN}  ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}  ! $1${NC}"; }
fail() { echo -e "${RED}  ✗ $1${NC}"; exit 1; }

TOTAL_STEPS=7

if [ $# -ne 1 ]; then
  echo "Usage: ./release.sh <version>"
  exit 1
fi

VERSION="$1"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Invalid version: $VERSION"

echo -e "${CYAN}Pre-flight checks...${NC}"
command -v gh >/dev/null   || fail "gh CLI not installed"
command -v node >/dev/null || fail "node not installed"
command -v npm >/dev/null  || fail "npm not installed"

CURRENT_VERSION=$(node -p "require('./package.json').version")

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  info "Resuming release v${VERSION}"
else
  [ -z "$(git status --porcelain)" ] || fail "Working directory not clean"
  info "Current version: $CURRENT_VERSION → $VERSION"
fi

if [ -z "${CI:-}" ] && [ "$CURRENT_VERSION" != "$VERSION" ]; then
  echo -e "\n${YELLOW}About to release v${VERSION}.${NC}"
  read -p "Continue? (y/N) " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
fi

step 1 "Test and lint"
npm run build || fail "Build failed"
npm run lint || fail "Lint failed"
npm run typecheck || fail "Type check failed"
npm test || fail "Tests failed"
info "All checks passed"

step 2 "Bump version to $VERSION"
if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  info "Already at v${VERSION} — skipping"
else
  npm version "$VERSION" --no-git-tag-version
  info "package.json updated"
fi

step 3 "Commit and tag"
if [ -n "$(git status --porcelain package.json package-lock.json 2>/dev/null)" ]; then
  git add package.json package-lock.json
  git commit -m "v${VERSION}"
  info "Committed version bump"
else
  info "Already committed — skipping"
fi
if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
  info "Tag v${VERSION} already exists — skipping"
else
  git tag "v${VERSION}"
  info "Tag v${VERSION} created"
fi

step 4 "Push to origin"
git push origin main --tags
info "Pushed commit and tag"

step 5 "Publish to npm"
NPM_VERSION=$(npm view @yawlabs/caddy-mcp version 2>/dev/null || echo "")
if [ "$NPM_VERSION" = "$VERSION" ]; then
  info "Already published to npm — skipping"
else
  npm publish --access public
  info "Published @yawlabs/caddy-mcp@${VERSION} to npm"
fi

step 6 "Create GitHub release"
if gh release view "v${VERSION}" >/dev/null 2>&1; then
  info "GitHub release v${VERSION} already exists — skipping"
else
  PREV_TAG=$(git tag --sort=-v:refname | grep -A1 "^v${VERSION}$" | tail -1)
  if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "v${VERSION}" ]; then
    CHANGELOG=$(git log --oneline "${PREV_TAG}..v${VERSION}" --no-decorate | sed 's/^[a-f0-9]* /- /')
  else
    CHANGELOG="Initial release"
  fi
  gh release create "v${VERSION}" --title "v${VERSION}" --notes "$CHANGELOG"
  info "GitHub release created"
fi

step 7 "Verify"
sleep 3
LIVE_VERSION=$(npm view @yawlabs/caddy-mcp version 2>/dev/null || echo "")
[ "$LIVE_VERSION" = "$VERSION" ] && info "npm: @yawlabs/caddy-mcp@${LIVE_VERSION}" || warn "npm: ${LIVE_VERSION} (propagating)"
GH_TAG=$(gh release view "v${VERSION}" --json tagName --jq '.tagName' 2>/dev/null || echo "")
[ "$GH_TAG" = "v${VERSION}" ] && info "GitHub: ${GH_TAG}" || warn "GitHub release: not found"

echo -e "\n${GREEN}  v${VERSION} released successfully!${NC}"
echo -e "${GREEN}  npm i @yawlabs/caddy-mcp@${VERSION}${NC}\n"
