---
title: "How to keep your code and secrets safe"
description: "Use separate run copies, protected branches, the secret scan, approvals, spending limits, sandboxes, workspaces and autonomy levels to keep code safe."
slug: safety
order: 4
group: "Configure and extend"
time: "PT20M"
---

This page is for admins who want to know what protects their code and how to tune it. The Foundry is safe by default: every run works in its own copy of the code, and pushes to protected branches or pushes that contain secrets are blocked. This page shows where each guard is set, and how to add approvals, limits, sandboxes and separate workspaces.

## Before you start

- You are signed in as an admin, in the Admin view.
- You can open **Administration** in the sidebar, then **Settings** under **System**.
- Optional: Docker, for shell steps that run in a container.

![The Settings page under Administration, System](../../docs/images/settings.png)

## Steps

### 1. Keep runs in their own copy

A flow's `workspace` decides where a run works. The default, `worktree`, is a new git worktree on a `factory/<run-id>` branch, so your checkout is never touched. `empty` is an empty folder that the flow clones into. Use `inplace` only for flows you trust: changes land directly in your checkout.

```yaml
workspace: worktree
one_per_repo: true
```

When a run finishes, its branch stays in your repository. Review it, merge it or delete it.

### 2. Check the protected branches

In the **Safety** section of Settings, **Protected branches** lists the branches that runs may not push to (default `main`, `master`, `develop`, `release/*`). Claude Code is not allowed to run `git push` at all, and Codex's sandbox has no network access by default: pushing is a flow step. For a hard block, also use branch protection on GitHub.

### 3. Let the secret scan work

Every push is checked for API keys, tokens, private keys, connection strings and `.env` or key files in the new commits. Findings are shown masked and the push is refused. For a false positive, add `factory:allow-secret` to the line, or a pattern to `.claude-factory/secret-allow` in the repository.

### 4. Give repository access only where it is needed

Mark only the shell steps that call `gh` or the remote with `repo_access: true`. Only they get the repository's credential. Agent steps never sign in to Git or GitHub. Never mark a step that runs tests or the build.

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

### 6. Set spending limits

On **Budget & capacity**, the daily budget stops new work when today's estimated spend reaches it. Under **Spending limits**, cap one issue (with its split parts and retries) and one month. In a flow, cap one run and each agent step with `limits.max_cost_usd` and `defaults.max_budget_usd`. A plugin can also check a run or a step before it starts. See [Control costs](/how-to/costs/).

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

On macOS, every step of a user's run is held by an operating-system sandbox: it cannot read your account's home, the data folder, other runs or the Keychain. If this computer cannot sandbox a user's run, the run does not start, unless you tick **Allow user runs without the OS sandbox**.

### 8. Keep teams apart on one Mac

When several teams share one Mac, list them as workspaces in `config.yaml`. A run of any workspace but `default` is held apart:

- every step runs in the operating-system sandbox; if the computer cannot sandbox it, the run is refused before any step starts;
- its agents reach only their model host, and its shell steps reach only GitHub, the package registries and the workspace's `hosts`;
- it never uses the machine's GitHub login, and `inplace` and `worktree` flows are refused;
- its runs, locks, learnings and skills are kept in its own folder.

A user sees only the repositories, runs and sessions of their own workspaces.

### 9. Limit how far a run may go

Open **Administration** → **Autonomy**. Each repository and each flow has a level: `observe`, `plan-only`, `guarded-write` or `delivery-handoff`. A run gets the lower of its repository's and its flow's level, and the engine refuses steps above it, for example every push below `delivery-handoff`. **Promote** asks for a higher level when the gate passes; **Demote** lowers one at once.

### 10. Know how to go back

A repository page lists its **Safe points**: recent versions that passed the checks. **Restore** first shows what would be taken back. **Yes, open the change** then opens a normal change that builds that version again, with tests and review. Nothing is reset or force-pushed.

## Check that it worked

- A run's branch is `factory/<run-id>`, and your checkout has no changes.
- When a step pushes to a protected branch or pushes a secret, the push is refused and the step output says why.
- **Administration** → **Audit** shows a `settings-change` line for each setting you changed.

![The Audit page: who did what, with filters](../../docs/images/audit.png)

## Next steps

- [Control costs and read the dashboard](/how-to/costs/)
- [Approve plans and answer questions](/how-to/approve-and-answer/)
- [Guide: Settings and safety](/guide/#7-settings-and-safety)
- [Guide: Workspaces](/guide/#workspaces)
