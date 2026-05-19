#!/bin/bash
# =============================================================================
# Release script -- build, tag, publish to npm, create GitHub release.
# =============================================================================
# Usage:
#   ./release.sh <version>     local mode -- bumps, commits, tags, pushes, then
#                              relies on CI (or local npm session) to publish.
#   ./release.sh               CI mode -- derives version from $GITHUB_REF_NAME,
#                              skips commit/tag/push (already done), publishes
#                              via $NODE_AUTH_TOKEN.
#
# If interrupted, re-run with the same version -- each step is idempotent.
# =============================================================================

set -euo pipefail
trap 'echo -e "\n\033[0;31m  x Release failed at line $LINENO (exit code $?)\033[0m"' ERR

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

step() { echo -e "\n${CYAN}=== [$1/$TOTAL_STEPS] $2 ===${NC}"; }
info() { echo -e "${GREEN}  - $1${NC}"; }
warn() { echo -e "${YELLOW}  ! $1${NC}"; }
fail() { echo -e "${RED}  x $1${NC}"; exit 1; }

TOTAL_STEPS=7

VERSION="${1:-}"
IS_CI="${CI:-false}"

# In CI the version comes from the tag that triggered the workflow.
if [ -z "$VERSION" ]; then
  if [ "$IS_CI" = "true" ] && [ -n "${GITHUB_REF_NAME:-}" ]; then
    VERSION="${GITHUB_REF_NAME#v}"
    info "CI mode -- version $VERSION from tag $GITHUB_REF_NAME"
  else
    echo "Usage: ./release.sh <version>"
    exit 1
  fi
fi

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Invalid version: $VERSION"

echo -e "${CYAN}Pre-flight checks...${NC}"
command -v node >/dev/null || fail "node not installed"
command -v npm >/dev/null  || fail "npm not installed"
# gh is only required outside CI (CI uses GITHUB_TOKEN via gh, but the binary
# may not be on the runner image; the GitHub-release step in CI is gh-only too,
# so still require it there).
command -v gh >/dev/null   || fail "gh CLI not installed"

CURRENT_VERSION=$(node -p "require('./package.json').version")

if [ "$IS_CI" != "true" ]; then
  [ -z "$(git status --porcelain)" ] || fail "Working directory not clean -- commit or stash changes before releasing"
  # If a CI release workflow exists, a missing local npm session is fine --
  # pushing the v* tag in step 4 will trigger CI to publish via NPM_TOKEN,
  # and step 5 here will then see "Already published -- skipping". Only
  # require a local session when there is no CI fallback to defer to.
  if [ ! -f .github/workflows/release.yml ]; then
    npm whoami >/dev/null 2>&1 || fail "No active npm session -- run 'npm login --auth-type=web' first."
  elif ! npm whoami >/dev/null 2>&1; then
    warn "No local npm session, but .github/workflows/release.yml exists -- step 5 will defer publish to CI on tag push."
    DEFER_PUBLISH_TO_CI=1
  fi
fi
: "${DEFER_PUBLISH_TO_CI:=0}"

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  info "Resuming release v${VERSION}"
else
  info "Current version: $CURRENT_VERSION -> $VERSION"
fi

if [ "$IS_CI" != "true" ] && [ "$CURRENT_VERSION" != "$VERSION" ]; then
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
  info "Already at v${VERSION} -- skipping"
else
  npm version "$VERSION" --no-git-tag-version
  info "package.json updated"
fi

step 3 "Commit and tag"
if [ "$IS_CI" = "true" ]; then
  info "CI mode -- commit/tag already exist on the triggering ref, skipping"
else
  if [ -n "$(git status --porcelain package.json package-lock.json 2>/dev/null)" ]; then
    git add package.json package-lock.json
    git commit -m "v${VERSION}"
    info "Committed version bump"
  else
    info "Already committed -- skipping"
  fi
  if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
    info "Tag v${VERSION} already exists -- skipping"
  else
    # Annotated (-a) so `git push --follow-tags` below picks it up;
    # lightweight tags are ignored by --follow-tags and would silently
    # fail to publish (release commit lands but tag-push is a no-op).
    git tag -a "v${VERSION}" -m "v${VERSION}"
    info "Tag v${VERSION} created"
  fi
fi

step 4 "Push to origin"
if [ "$IS_CI" = "true" ]; then
  info "CI mode -- already pushed (this run was triggered by the push), skipping"
else
  # --follow-tags pushes only annotated tags reachable from the pushed
  # commits, not every local tag. Avoids accidentally publishing dangling
  # experimental tags that happen to be lying around.
  git push origin main --follow-tags
  info "Pushed commit and tag"
fi

step 5 "Publish to npm"
NPM_VERSION=$(npm view "@yawlabs/caddy-mcp@${VERSION}" version 2>/dev/null || echo "")
if [ "$NPM_VERSION" = "$VERSION" ]; then
  info "Already published to npm -- skipping"
elif [ "$DEFER_PUBLISH_TO_CI" = "1" ]; then
  info "Deferring publish to CI -- the v${VERSION} tag pushed in step 4 will trigger .github/workflows/release.yml."
else
  # --provenance requires an OIDC-signing-capable environment (GitHub Actions
  # with id-token: write). Locally the flag aborts the publish with
  # "Automatic provenance generation not supported for provider: null".
  if [ "$IS_CI" = "true" ]; then
    npm publish --access public --provenance
  else
    # WebAuthn propagation: a freshly-logged-in npm web session can take ~30s
    # to register with npm's auth backend. The first 1-2 publishes after
    # `npm login --auth-type=web` may EOTP -- WebAuthn has no TOTP fallback,
    # so the only recovery is to wait and retry. Documented per-shape
    # exception to the global single-retry rule.
    publish_attempt=1
    publish_max=3
    while true; do
      if npm publish --access public; then
        break
      fi
      if [ "$publish_attempt" -ge "$publish_max" ]; then
        fail "npm publish failed after $publish_max attempts"
      fi
      warn "publish attempt $publish_attempt failed -- waiting 30s (WebAuthn propagation pattern)"
      sleep 30
      publish_attempt=$((publish_attempt + 1))
    done
  fi
  info "Published @yawlabs/caddy-mcp@${VERSION} to npm"
fi

step 6 "Create GitHub release"
if gh release view "v${VERSION}" >/dev/null 2>&1; then
  info "GitHub release v${VERSION} already exists -- skipping"
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
# A successful `npm publish` doesn't guarantee instant registry visibility.
# Poll up to 5 times with 5s spacing, matching the CI smoke-test cadence.
LIVE_VERSION=""
for i in 1 2 3 4 5; do
  LIVE_VERSION=$(npm view "@yawlabs/caddy-mcp@${VERSION}" version 2>/dev/null || echo "")
  [ "$LIVE_VERSION" = "$VERSION" ] && break
  if [ "$i" -lt 5 ]; then sleep 5; fi
done
[ "$LIVE_VERSION" = "$VERSION" ] && info "npm: @yawlabs/caddy-mcp@${LIVE_VERSION}" || warn "npm: not yet visible (registry propagating)"
GH_TAG=$(gh release view "v${VERSION}" --json tagName --jq '.tagName' 2>/dev/null || echo "")
[ "$GH_TAG" = "v${VERSION}" ] && info "GitHub: ${GH_TAG}" || warn "GitHub release: not found"

# In CI, attestations are attached because we publish with --provenance. A
# missing attestation means the OIDC step regressed; it's a CI-only check.
if [ "$IS_CI" = "true" ]; then
  ATTEST=$(npm view "@yawlabs/caddy-mcp@${VERSION}" dist.attestations.provenance.predicateType 2>/dev/null || echo "")
  if [ -n "$ATTEST" ]; then
    info "provenance attestation: $ATTEST"
  else
    warn "no provenance attestation found on v${VERSION} (expected in CI publish)"
  fi
fi

echo -e "\n${GREEN}  v${VERSION} released successfully!${NC}"
echo -e "${GREEN}  npm i @yawlabs/caddy-mcp@${VERSION}${NC}\n"
