# Local Branch Strategy

This repo tracks upstream `openclaw/openclaw` with local feature branches
for changes we're developing/submitting upstream.

## Branch Layout

- **`main`** — our deployment branch. Merges upstream `main` + all local feature
  branches + `local-only`. This is what we deploy to our server.

- **`local-only`** — local-only config and notes (AGENTS.md tweaks,
  LOCAL-BRANCHES.md, etc.) that should never be pushed to upstream.

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
git merge fix/android-tailscale-gateway
```

This applies after:

- Pushing review-feedback fixes to a PR branch
- Adding notes/config to `local-only`
- Pulling new upstream commits

### Responding to code reviews

PRs are reviewed by other agents. Watch PRs for comments from Greptile and iterate with them until they are happy.
When pushing fixes that address @greptileai review comments, mention `@greptileai` in the PR reply so it knows to re-review. Ask it to update its summary.
Don't delete the Greptile summary from the PR description.

## Deploying

The server is `openclaw@openclaw-gateway`. The gateway runs from
`~/openclaw-src` via a user systemd service.

### Server details

- **Service:** `openclaw-gateway.service` (user systemd, `~/.config/systemd/user/`)
- **ExecStart:** `node /home/openclaw/openclaw-src/openclaw.mjs gateway`
- **Source dir:** `~/openclaw-src` (rsync'd, not a git repo)
- **Node:** v22 (system install)
- **Deps:** pnpm (frozen lockfile)
- **Tailscale serve:** auto-enabled by gateway on port 18789

### Deploy steps

```bash
# 1. Build locally on main
git checkout main
pnpm build

# 2. Rsync to server (exclude git, node_modules, mobile apps)
rsync -avz --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='apps/android' \
  --exclude='apps/ios' \
  --exclude='apps/macos' \
  --exclude='.github' \
  --exclude='LOCAL-BRANCHES.md' \
  --exclude='NOTES-*.md' \
  ./ openclaw@openclaw-gateway:~/openclaw-src/

# 3. Install deps on server
ssh openclaw@openclaw-gateway "cd ~/openclaw-src && pnpm install --frozen-lockfile"

# 4. Restart the gateway
ssh openclaw@openclaw-gateway "systemctl --user restart openclaw-gateway.service"

# 5. Verify
ssh openclaw@openclaw-gateway "systemctl --user status openclaw-gateway.service"
ssh openclaw@openclaw-gateway "journalctl --user -u openclaw-gateway.service --since '30 seconds ago' --no-pager"
```

### Quick deploy (one-liner after build)

```bash
rsync -avz --delete --exclude='.git' --exclude='node_modules' --exclude='apps/android' --exclude='apps/ios' --exclude='apps/macos' --exclude='.github' --exclude='LOCAL-BRANCHES.md' --exclude='NOTES-*.md' ./ openclaw@openclaw-gateway:~/openclaw-src/ && \
ssh openclaw@openclaw-gateway "cd ~/openclaw-src && pnpm install --frozen-lockfile && systemctl --user restart openclaw-gateway.service"
```

## Updating (full refresh)

```bash
# Pull latest upstream
git checkout main
git pull origin main

# Merge all local branches
git merge local-only
git merge feat/matrix-multi-account
git merge fix/android-tailscale-gateway
git merge fix/matrix-block-streaming
```

## Notes

- `apps/android/NOTES-android-gateway.md` has detailed notes on operator session
  removal and per-agent node restrictions (future work)
- See also the two upstream PRs that overlap with our Android work:
  - https://github.com/openclaw/openclaw/pull/5819 (broader compat)
  - https://github.com/openclaw/openclaw/pull/5867 (Ed25519 + token UI)
