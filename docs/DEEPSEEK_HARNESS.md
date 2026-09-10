# DeepSeek Harness in OptiLink Codespaces

This repository uses DeepSeek Harness as a Codespaces implementation/debugging agent. GitHub remains the source of truth for Issue/PR/CI/Gate/merge state, and the Product Owner remains the merge authority.

## Installation and startup

The Codespace lifecycle is defined in `.devcontainer/devcontainer.json`:

- `postCreateCommand` runs `.devcontainer/setup-deepseek-harness.sh`.
- `postStartCommand` runs `.devcontainer/start-deepseek-harness.sh`.
- Web UI port `3080` is forwarded privately.

The setup script installs the pinned package `@deepseek-ai/dsh@0.1.2-rc.1` under `$HOME/.local`, creates the stable command `$HOME/.local/bin/dsh`, and adds that directory to Bash PATH.

The startup script starts `dsh web --no-open --port 3080` only when the service is not already listening. Runtime files live outside the repository:

- log: `$HOME/.optilink/deepseek-harness.log`
- pid: `$HOME/.optilink/deepseek-harness.pid`

## Credential setup

Create a GitHub Codespaces secret named:

```text
DEEPSEEK_API_KEY
```

Do not put the value in this repository, `.devcontainer`, `.env`, shell scripts, issues, PR comments, or logs. After adding/changing the secret, restart the Codespace and verify:

```bash
test -n "${DEEPSEEK_API_KEY:-}" && echo "DEEPSEEK_API_KEY available"
```

Never echo the value itself.

## Health checks

```bash
command -v dsh
dsh --version
(echo >/dev/tcp/127.0.0.1/3080) >/dev/null 2>&1 && echo "Harness Web listening"
```

The Web UI uses a token-protected URL, so an unauthenticated `curl --fail http://127.0.0.1:3080/` is not a valid health check and may report failure even when the service is healthy.

For a minimal model call:

```bash
dsh --profile headless "Reply exactly: DSH_OK"
```

## OptiLink agent entry point

Prefer the repository wrapper for project work because it prepends the OptiLink Harness policy:

```bash
scripts/dsh-optilink "Inspect the current implementation and report technical blockers. Do not modify files."
```

For an implementation task:

```bash
scripts/dsh-optilink "Run the relevant tests, diagnose the failure, and make the minimal fix. Do not merge any PR."
```

The policy is stored in `docs/DEEPSEEK_HARNESS_POLICY.md`.

## Recovery

If `dsh` is missing:

```bash
bash .devcontainer/setup-deepseek-harness.sh
source ~/.bashrc
```

If Web Harness is down:

```bash
bash .devcontainer/start-deepseek-harness.sh
```

Inspect startup logs without exposing secrets:

```bash
tail -n 80 "$HOME/.optilink/deepseek-harness.log"
```

## Version upgrades

DeepSeek Harness is developer-preview software and may introduce compatibility-breaking changes. Upgrade the pinned `DSH_VERSION` only through a dedicated Issue/branch/PR with a headless smoke test and Web startup validation before merge.
