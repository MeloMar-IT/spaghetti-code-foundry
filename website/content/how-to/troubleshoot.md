---
title: "How to fix common problems"
description: "Find out why nothing happens to an issue, why a run failed or a push was refused, and fix Codex, local model, budget and sign-in problems."
slug: troubleshoot
order: 7
group: "Configure and extend"
time: "PT15M"
---

This page is for anyone whose run, watcher or sign-in does not do what they expect. Each section names a problem, its cause and the fix. Every failure message already says what happened, why and what to do first; start there.

## Before you start

- You can open the web UI, or a terminal on the machine that runs the Foundry.
- For settings, users and watchers, you need an admin account.

## Nothing is happening to an issue

**Cause.** The issue waits for you, for another issue, for a limit, or the Foundry itself has a problem. Watchers only run while `scf ui` or `scf serve` runs.

**Fix.** First look at the health line under the top bar: it says when the Foundry itself is the problem. Then open **Administration** → **Dashboard** and read the **Waiting** card. Each line starts with who has the next move (**You**, **Foundry**, **Another story**, **A time limit**, **Something is wrong**), what to do and why. If a line says "has not checked since …", press **Check now** on the **Watchers** page.

## A plan is waiting for approval

**Cause.** Its risk score is above 75, or the issue has `Factory_review_plan`.

**Fix.** Read the plan on the issue and reply `/approve` (with notes if you like) or `/reject` with what to change.

## A run failed

**Cause.** The failure card on the run page names the step and the reason, for example a command that ended with an error, a time limit, or a used-up budget.

**Fix.** Fix the cause, then press **Retry from the failing step** on the run page, or from the terminal:

```bash
scf resume <run-id>
```

For an issue the Foundry watches, you can also remove the `factory:failed` label to start over. The settings behind the messages are `max_visits` (attempts), `limits.max_cost_usd` (run budget), `max_budget_usd` (step budget) and `timeout_sec` (time limit). A flow change only counts for a new run.

## A push was refused

**Cause.** The branch is protected, or the secret scan found something.

**Fix.** For a protected branch, change **Protected branches** in **Administration** → **Settings**, or the flow's branch. For a secret, the step output lists the file, line and kind of secret: remove it from the code. For a false positive, add `factory:allow-secret` to the line or a pattern to `.claude-factory/secret-allow`.

## "Codex is not installed" or "Codex is not logged in"

**Fix.** Install Codex and log in, on the computer that runs the Foundry. The **Models** page shows the status.

```bash
npm i -g @openai/codex
codex login
```

## A local model says it is done but changed nothing

**Cause.** The model is not good at tool use.

**Fix.** Try a coding model (`qwen3-coder`, `gpt-oss`) and use **Try a model** on the Models page.

## A run stopped with "daily budget reached"

**Fix.** It continues by itself the next day, or when you raise the budget and resume it.

## A watcher cannot reach GitHub

**Fix.** Check the network, and that `gh auth status` works in the terminal where the Foundry runs. **Error details** on the watcher card shows gh's first output line. **Check now** retries at once.

## Tests fail for reasons unrelated to the change

**Fix.** Set the right command with the `test_cmd` variable, per repository in `<repo>/.claude-factory/config.yaml`:

```yaml
vars:
  test_cmd: ./gradlew test
```

## Locked out or forgot the password

**Fix.** After many wrong tries, wait 30 minutes or ask an admin to press **Unlock** on the Users page. For a lost password, ask an admin to use **Reset password**, or run this on the machine:

```bash
scf user password <e-mail>
```

## The credential store is not working

**Fix.** Run `scf credential check` and unlock the login keychain if it fails. "An old key is still in the Keychain" is cleared with `scf credential rotate-key`.

## Check that it worked

- The health line says "All good".
- The run page shows the run as running again, or finished.
- The issue no longer shows up on the **Waiting** card with a problem.

## Next steps

- [Resume a run](/how-to/resume-run/)
- [Approve plans and answer questions](/how-to/approve-and-answer/)
- [Ask SCF why something does not work](/how-to/ask-scf/)
- [Guide: Troubleshooting](/guide/#10-troubleshooting)
