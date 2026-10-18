---
title: "How to keep your code and secrets safe"
description: "Use separate run workspaces, protected branches, the secret scan, approval steps, budgets and sandboxing so runs cannot harm your code."
slug: safety
order: 4
group: "Configure and extend"
time: "PT20M"
---

This page is for admins who want to know what protects their code and how to tune it. The Foundry is safe by default: every run works in its own copy of the code, pushes to protected branches and pushes that contain secrets are blocked. This page shows where each guard is set and how to add approvals, budgets and sandboxing.

## Before you start

- You are signed in as an admin.
- You can open **Administration** → **Settings**.
- Optional: Docker, for shell steps that run in a container.

## Steps

### 1. Keep runs in their own copy

A flow's `workspace` decides where a run works. The default, `worktree`, is a new git worktree on a `factory/<run-id>` branch, so your checkout is never touched. `empty` is an empty folder that the flow clones into. Use `inplace` only for flows you trust: changes land directly in your checkout.

```yaml
workspace: worktree
one_per_repo: true
```

When a run finishes, its branch stays in your repository. Review it, merge it or delete it.

### 2. Check the protected branches

In **Administration** → **Settings** → **Safety**, **Protected branches** lists the branches that runs may not push to (default `main`, `master`, `develop`, `release/*`). Claude Code is not allowed to run `git push` at all, and Codex's sandbox has no network access by default: pushing is a flow step. For a hard block, also use branch protection on GitHub.

### 3. Let the secret scan work

Every push is checked for API keys, tokens, private keys, connection strings and `.env` or key files in the new commits. Findings are shown masked and the push is refused. For a false positive, add `factory:allow-secret` to the line, or a pattern to `.claude-factory/secret-allow` in the repository.

### 4. Give repository access only where it is needed

Mark only the shell steps that call `gh` or the remote with `repo_access: true`. Only they get the repository's credential. Never mark a step that runs tests or the build.

```yaml
- id: push
  type: shell
  repo_access: true
  run: git push -q -u origin HEAD
```

### 5. Add approval steps

An approval step pauses the run until a person approves or rejects. Put one before anything irreversible:

```yaml
- id: approve
  type: approval
  message: "Push the changes for {{vars.github_repo}}?"
  on_failure: stop
```

In `issue-gitflow`, every plan also gets a risk score from 0 to 100; above 75 (`risk_threshold`) a person must `/approve` it before any code is written.

### 6. Set budgets

Under **Budget & capacity**, the daily budget stops new work when today's estimated spend reaches it. In a flow, cap one run and each agent step:

```yaml
limits:
  max_cost_usd: 20
defaults:
  max_budget_usd: 5
```

### 7. Turn on sandboxing

*Sandbox agents' shell commands* limits what agents' shell commands can write to the run's workspace. Shell steps marked **Run in Docker** run in the image you set, with only the workspace mounted:

```yaml
sandbox:
  claude: true
  docker_image: node:22
steps:
  - id: test
    type: shell
    run: "{{vars.test_cmd}}"
    sandbox: true
```

On macOS, every step of a user's run is also held by a sandbox profile that cannot read your account's files or the Keychain.

## Check that it worked

- A run's branch is `factory/<run-id>`, and your checkout has no changes.
- When a step pushes to a protected branch or pushes a secret, the push is refused and the step output says why.
- The **Audit** page under **Administration** shows a `settings-change` line for each setting you changed.

## Next steps

- [Control costs and read the dashboard](/how-to/costs/)
- [Approve plans and answer questions](/how-to/approve-and-answer/)
- [Guide: Settings and safety](/guide/#7-settings-and-safety)
- [Guide: Roles and permissions](/guide/#roles-and-permissions)
