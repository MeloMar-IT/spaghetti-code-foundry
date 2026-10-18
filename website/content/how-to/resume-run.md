---
title: "How to resume, retry or approve a stopped run"
description: "Find out why a run stopped or failed, fix the cause, then resume it at the failed step, retry it with a hint, or approve it to go on."
slug: resume-run
order: 2
group: "Daily work"
time: "PT10M"
---

This page is for you when a run failed, stopped or waits for a decision. Runs keep what they already did, so you rarely need to start over. You learn how to read the failure, choose the right option, and continue the run from the app, from GitHub or from the command line.

## Before you start

- You can open the run: it is your own run, or you are an admin.
- For a watched issue: the issue is still open on GitHub. Resume, approve, reject and retry are refused for a closed issue.

## Steps

### 1. Find the run

Open **Home**. Failed or stopped work shows under **Needs you**, with **Details** to open the run. You can also open **Runs**: the sections **Needs you** and **Failed** come first. A run that waits for a limit, the budget or another run is not under **Needs you**; it continues by itself.

### 2. Read the failure card

A failed run shows a **failure card**: who has the next move, the kind of problem, what happened, why, what the Foundry already tried and what to do first. **Show the failed step** opens the step that explains it. The kinds are:

- **A problem in the code** — tests keep failing, or a review is rejected.
- **A problem with the environment or the Foundry** — a blocked command, a login, the network, wrong model settings. The card then says "The Foundry failed, not the code" and names the fix.
- **A limit** — the budget of a step or of the run was used up.
- **A person's decision** — someone rejected an approval.

### 3. Fix the cause

Do what the card says first. For example: answer the question, allow a blocked command in the flow, sign in again with `gh auth login`, or install a missing `claude` or `codex` program. A usage limit, the daily budget and an unreachable AI service do not fail a run: they pause it, and it continues by itself.

### 4. Choose an option

| Option | Watched issue | Run by hand |
|---|---|---|
| Retry | Remove the failed label, or resume the run on its page | Resume the run on its page |
| Retry with a hint | Write the hint as a comment on the issue, then remove the failed label | Start a new run and put the hint in its task |
| Change the plan | Change the text of the issue, then remove the failed label | Change the task, then start a new run |
| Close | Close the issue if the work is no longer wanted | Leave the run as it is |

On **Home**, a failed item also has **Retry** and **Retry with a hint…**.

### 5. Resume on the run page

Press **Retry from the failing step**. It continues the run from the step where it stopped, with everything it already did kept. **Retry from step…** re-runs from an earlier step. An *interrupted* run (for example after a restart) can be resumed the same way; a watcher does this by itself.

### 6. Approve a waiting run

A run that waits at an approval step shows **You** in **What happens next**. Press **Approve** or **Reject**; both open a dialog with an optional note. For a GitHub flow you can also comment `/approve` or `/reject` on the issue.

### 7. Or use the command line

```bash
scf resume <run-id>
scf resume <run-id> --from <step>
scf approve <run-id> --note "…"
scf reject <run-id>
```

For a closed issue these commands refuse and say "Use --force to resume it anyway."; `--force` continues anyway.

## Check that it worked

- The run's status changes to *queued* or *working*, and the header shows "resumed N×".
- On a watched issue the label becomes `factory:working` (or your own name for it) at the next check.
- The item leaves **Needs you** on Home.

## Next steps

- [Answer questions and approve risky plans](/how-to/approve-and-answer/)
- [Troubleshoot the Foundry](/how-to/troubleshoot/)
- [When something goes wrong, in the user guide](/guide/#when-something-goes-wrong)
- [Command line reference](/guide/#9-command-line)
