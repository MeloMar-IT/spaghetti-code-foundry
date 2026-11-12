---
title: "How to fix common problems"
description: "Use the Setup check and the Problems page, find out why nothing happens to an issue or a change failed, and fix push, Codex, budget and sign-in problems."
slug: troubleshoot
order: 7
group: "Configure and extend"
time: "PT15M"
---

This page is for anyone whose change, watcher or sign-in does not do what they expect. Each section names a problem, its cause and the fix. Every failure message already says, in plain words, what happened, why and what to do first; start there. The raw text stays available under **Raw details** on the change's page.

## Before you start

- You can open the web UI, or a terminal on the machine that runs the Foundry.
- For settings, users, watchers and the Problems page, you need an admin account in the Admin view.

## Something is missing on this computer

**Fix.** As an admin, open the **Setup check** (type "Setup" in **Search**, or go to `#/setup`). It checks Git, Claude Code, Codex and their sign-ins. Each item shows a green tick, or a plain explanation with one command to copy. Press **Check again** after you fix one. In a terminal, run `scf doctor --simple`.

![The Setup check: what this computer still needs](../../docs/images/setup-check.png)

## Something is wrong with the Foundry itself

**Fix.** Press the health chip in the top bar to open the health line; it opens by itself when something is wrong. Then open **Administration**, then **Problems** under **Operations**. It lists what the monitor found, with the state of each problem and its bug-fix change. **Make a bug-fix change now** starts one at once; **Mute** or **This is not a problem** silences a finding.

![The Problems page: the monitor's sentence, the findings and the detectors](../../docs/images/problems.png)

The **Overview** page of **Administration** shows problems, the queue, watchers and today's spending on one page.

## Nothing is happening to an issue

**Cause.** The issue waits for you, for another issue, for a limit, or the Foundry itself has a problem. Watchers only run while `scf ui` or `scf serve` runs.

**Fix.** First look at the health line. Then open **Administration** → **Dashboard** and read the **Waiting** card. Each line says who has the next move, what to do and why. If a line says "has not checked since …", press **Check now** on **Administration** → **Watchers**.

## A plan is waiting for approval

**Cause.** Its risk score is above 75, or the issue has `Factory_review_plan`.

**Fix.** Read the plan on the issue and reply `/approve` (with notes if you like) or `/reject` with what to change. It also shows under **Needs you** on **Today**.

## A change failed

**Cause.** The failure card on the change's page names the step and the reason, for example a command that ended with an error, a time limit, or a used-up budget. In the Simple view, the project page says the change got stuck, with **Try again** and **Ask for help**, which opens Ask Foundry.

**Fix.** Fix the cause, then press **Retry from the failing step** on the change's page, or from the terminal:

```bash
scf resume <run-id>
```

For an issue the Foundry watches, you can also remove the `factory:failed` label to start over. The settings behind the messages are `max_visits` (attempts), `limits.max_cost_usd` (run budget), `max_budget_usd` (step budget) and `timeout_sec` (time limit). A flow change only counts for a new run.

## A push was refused

**Cause.** The branch is protected, the secret scan found something, or the autonomy level of the repository or flow is below `delivery-handoff`.

**Fix.** For a protected branch, change **Protected branches** in **Administration** → **Settings**, or the flow's branch. For a secret, the step output lists the file, line and kind of secret: remove it from the code. For a false positive, add `factory:allow-secret` to the line or a pattern to `.claude-factory/secret-allow`. For an autonomy refusal, see **Administration** → **Autonomy**.

## "Codex is not installed" or "Codex is not logged in"

**Fix.** Install Codex and log in, on the computer that runs the Foundry. **Administration** → **Models** and the Setup check show the status.

```bash
npm i -g @openai/codex
codex login
```

## A local model says it is done but changed nothing

**Cause.** The model is not good at tool use.

**Fix.** Try a coding model (`qwen3-coder`, `gpt-oss`) and use **Try a model** on **Administration** → **Models**.

## A change stopped on a budget or a limit

**Fix.** "Daily budget reached" continues by itself the next day, or when you raise the budget and resume it. A change whose issue reached its limit goes on after an admin presses **Raise the change's limit** on its page. Work that waits for this month's budget starts in the next month.

## A watcher cannot reach GitHub

**Fix.** Check the network, and that `gh auth status` works in the terminal where the Foundry runs. **Error details** on the watcher card shows gh's first output line. **Check now** retries at once.

## Tests fail for reasons unrelated to the change

**Fix.** Set the right command with the `test_cmd` variable, per repository in `<repo>/.claude-factory/config.yaml`:

```yaml
vars:
  test_cmd: ./gradlew test
```

## Locked out or forgot the password

**Fix.** After many wrong tries, wait 30 minutes or ask an admin to press **Unlock** on the account's page under **Administration** → **Users**. For a lost password, ask an admin to use **Reset password**, or run this on the machine:

```bash
scf user password <e-mail>
```

With an identity provider, passwords are changed in your own account system. If that system is down, the one emergency local admin can still sign in.

## The credential store is not working

**Fix.** Run `scf credential check` and unlock the login keychain if it fails. "An old key is still in the Keychain" is cleared with `scf credential rotate-key`.

## Check that it worked

- The health line says "All good", and the Setup check shows green ticks.
- The change's page shows it as running again, or finished.
- The issue no longer shows up on the **Waiting** card with a problem.

## Next steps

- [Resume a run](/how-to/resume-run/)
- [Approve plans and answer questions](/how-to/approve-and-answer/)
- [Ask Foundry why something does not work](/how-to/ask-scf/)
- [Guide: Troubleshooting](/guide/#10-troubleshooting)
