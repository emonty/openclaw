# Local Branch Strategy

This repo tracks upstream `openclaw/openclaw` with local feature branches
for changes we're developing/submitting upstream.

## Branch Layout

- **`main`** — our deployment branch. Merges upstream `main` + all local feature
  branches + `local-only`. This is what we deploy to our server.

- **`local-only`** — local-only config and notes (AGENTS.md tweaks,
  LOCAL-BRANCHES.md, etc.) that should never be pushed to upstream.

- **`feat/matrix-multi-account`** — Matrix multi-account support.
  Adds `channels.matrix.accounts` config for running multiple Matrix bot
  accounts from a single gateway. PR pending upstream.

- **`fix/android-tailscale-gateway`** — Android app fixes for Tailscale serve.
  BouncyCastle Ed25519 fallback, auto-TLS for `.ts.net`, operator session
  client ID fix, canvas URL normalization, token/password UI.
  Upstream PR: https://github.com/openclaw/openclaw/pull/11205

## Workflow

1. Develop on feature branches (one per upstream PR)
2. Push feature branches to our fork for PRs
3. Merge all feature branches + `local-only` into local `main` for deployment
4. When upstream merges a PR, the next `git pull origin main` on `main`
   brings it in; the feature branch can then be deleted

### Keeping main up to date

**Any time a local branch is updated** (new commits on `local-only`,
`feat/*`, or `fix/*`), rebuild `main` so it stays current:

```bash
git checkout main
git pull origin main            # get latest upstream
git merge local-only            # local-only config/notes
git merge feat/matrix-multi-account
git merge fix/android-tailscale-gateway
```

This applies after:

- Pushing review-feedback fixes to a PR branch
- Adding notes/config to `local-only`
- Pulling new upstream commits

## Updating (full refresh)

```bash
# Pull latest upstream
git checkout main
git pull origin main

# Merge all local branches
git merge local-only
git merge feat/matrix-multi-account
git merge fix/android-tailscale-gateway
```

## Notes

- `apps/android/NOTES-android-gateway.md` has detailed notes on operator session
  removal and per-agent node restrictions (future work)
- See also the two upstream PRs that overlap with our Android work:
  - https://github.com/openclaw/openclaw/pull/5819 (broader compat)
  - https://github.com/openclaw/openclaw/pull/5867 (Ed25519 + token UI)
