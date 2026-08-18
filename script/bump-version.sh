#!/usr/bin/env bash
# Bump the patch version, commit, push to main, and tag vX.Y.Z on what landed.
#
# Ported from specguard-rspec's script/bump-version.sh, adapted for an npm
# package:
#   - the version source is package.json, and package-lock.json carries the
#     same number in two places. `npm version --no-git-tag-version` rewrites
#     both consistently; a sed on package.json alone would leave the lockfile
#     naming the old version, and `npm ci` in a later run would restore it.
#   - the already-published guard asks the npm registry instead of RubyGems.
#
# Strategy carried over verbatim: must be on main with a clean tree, patch-only
# bump, commit "bump: X -> Y", pull --rebase + push with up to 3 retries.
#
# When run inside GitHub Actions (GITHUB_OUTPUT set), exports `version` and
# `tag` to the step's job outputs. Locally it just prints the new version.
set -e

PACKAGE_NAME="specguard-mcp"

# Ensure we're on the main branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
    echo "Error: Not on main branch. Current branch: $CURRENT_BRANCH"
    exit 1
fi

# Check that no TRACKED file has uncommitted changes. Untracked files are not a
# reason to refuse: this runs in CI right after the suite, and both the build
# (dist/) and the test compile (.test-build/) drop artefacts — gitignored, but
# present. What must be clean is the content the bump is about to commit.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "Error: tracked files have uncommitted changes:"
    git status --porcelain --untracked-files=no
    exit 1
fi

if [ ! -f "package.json" ]; then
    echo "Error: package.json not found"
    exit 1
fi

CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "Current version: $CURRENT_VERSION"

# Bump patch version (0.1.0 -> 0.1.1)
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
echo "New version: $NEW_VERSION"

# A published npm version is immutable — the registry refuses a re-publish, and
# unpublish is available only for 72 hours and does not free the number for
# reuse afterwards. Refuse locally rather than discovering it after a build,
# and refuse a reused tag for the same reason the release does.
if git rev-parse -q --verify "refs/tags/v$NEW_VERSION" >/dev/null || \
   git ls-remote --exit-code --tags origin "refs/tags/v$NEW_VERSION" >/dev/null 2>&1; then
    echo "Error: tag v$NEW_VERSION already exists — package.json and the tags disagree"
    exit 1
fi
if command -v curl >/dev/null 2>&1; then
    # 200 = that exact version is published; 404 = either the version or the
    # whole package is absent, both fine. Any other status (or no network) is
    # inconclusive and must not block the release, so only 200 refuses.
    STATUS=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 \
             "https://registry.npmjs.org/$PACKAGE_NAME/$NEW_VERSION" 2>/dev/null || true)
    if [ "$STATUS" = "200" ]; then
        echo "Error: $PACKAGE_NAME $NEW_VERSION is already published on npm"
        exit 1
    fi
fi

# Rewrite package.json + package-lock.json. --no-git-tag-version because the
# commit and the tag are this script's job, below, and npm's own tagging would
# create v$NEW_VERSION before the rebase — the exact ordering bug the retry
# loop is written to avoid.
npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version >/dev/null
WROTE=$(node -p "require('./package.json').version")
if [ "$WROTE" != "$NEW_VERSION" ]; then
    echo "Error: package.json still reports $WROTE after the rewrite"
    exit 1
fi

# Create commit
git add package.json package-lock.json
git commit -m "bump: $CURRENT_VERSION -> $NEW_VERSION"

# Pull with rebase to incorporate any commits that landed on main since checkout,
# then push the branch and the tag. Retry up to 3 times to handle concurrent pushes.
#
# The tag is created INSIDE the loop, after `git push origin main` succeeds, and
# never before the rebase. `git pull --rebase` replays the bump commit onto the
# advanced main and gives it a new SHA; tags do not follow a rebase, so a tag
# created beforehand would name an abandoned object that is not an ancestor of
# main — while the workflow packs the tarball from the post-rebase tree. A
# published npm version is immutable, so that divergence would be permanent.
#
# `-f` makes a retry idempotent when an earlier attempt created the local tag but
# failed to push it. It cannot clobber a published tag: the tag-reuse guard above
# already refused that case before any work started.
MAX_RETRIES=3
RETRY_COUNT=0
PUSH_SUCCESS=false

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if git pull --rebase origin main; then
        # HEAD is now the rebased bump commit — the object the tag must name.
        if git push origin main; then
            git tag -f "v$NEW_VERSION" HEAD
            if git push origin "v$NEW_VERSION"; then
                PUSH_SUCCESS=true
                break
            fi
        fi
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
        echo "Push failed, retrying ($RETRY_COUNT/$MAX_RETRIES)..."
        sleep 5
    fi
done

if [ "$PUSH_SUCCESS" = false ]; then
    echo "Error: Failed to push version bump after $MAX_RETRIES attempts"
    exit 1
fi

echo "Version bumped to $NEW_VERSION and pushed to main with tag v$NEW_VERSION"

# Export to GitHub Actions job outputs when run in CI
if [ -n "$GITHUB_OUTPUT" ]; then
    echo "version=$NEW_VERSION" >> "$GITHUB_OUTPUT"
    echo "tag=v$NEW_VERSION" >> "$GITHUB_OUTPUT"
fi
