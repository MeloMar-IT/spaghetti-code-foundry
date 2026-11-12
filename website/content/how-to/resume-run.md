---
title: "How to resume, retry or restore a stopped change"
description: "Find out in plain words why a change stopped, fix the cause, then retry it, retry with a hint, approve it, or restore a safe point."
slug: resume-run
order: 2
group: "Daily work"
time: "PT10M"
---

This page is for you when a change failed, stopped or waits for a decision. Behind each change is a run, and runs keep what they already did, so you rarely need to start over. You learn how to read what went wrong, choose the right option, and continue from the app, from GitHub or from the command line. If a finished version turned out bad, you can also go back to a safe point.

## Before you start

- You can open the change: it is your own, or you are an admin.
- For a watched issue: the issue is still open on GitHub. Resume, approve, reject and retry are refused for a closed issue.

## Steps

### 1. Find the change

Open **Today**. A failed or stopped change shows under **Needs you** with one sentence on what happened. **See what happened** opens the technical cause. You can also open **Changes**: the changes that need you come first. A change that waits for a limit, the budget or another change is not under **Needs you**; it continues by itself.

In the Simple view, a stuck change says "This got stuck: the Foundry could not finish it by itself." with **Try again**, **Ask for help** (it opens Ask Foundry) and **Not now**.

### 2. Read the failure card

Open the change. A failed change shows a **failure card**: who has the next move, the kind of problem, what happened, why, what the Foundry already tried and what to do first. The raw reason is one click away under **Raw details**. **Show the failed step** opens the step in **Details** › **Steps**. The kinds are:

- **A problem in the code** — tests keep failing, or a review is rejected.
- **A problem with the environment or the Foundry** — a blocked command, a login, the network, wrong model settings. The card then says "The Foundry failed, not the code" and names the fix.
- **A limit** — the budget of a step or of the run was used up.
- **A person's decision** — someone rejected an approval.

### 3. Fix the cause

Do what the card says first. For example: answer the question, allow a blocked command in the flow, sign in again with `gh auth login`, or install a missing `claude` or `codex` program. A usage limit, the daily budget and an unreachable AI service do not fail a change: they pause it, and it continues by itself.

### 4. Choose an option

| Option | Watched issue | Started by hand |
|---|---|---|
| Retry | Remove the failed label, or retry on the change's page | Retry on the change's page |
| Retry with a hint | Write the hint as a comment on the issue, then remove the failed label | Start a new change and put the hint in its task |
| Change the plan | Change the text of the issue, then remove the failed label | Change the task, then start a new change |
| Close | Close the issue if the work is no longer wanted | Leave the change as it is |

In the Admin view, a failed item in **Your turn** also has **Retry** and **Retry with a hint…**.

### 5. Retry on the change's page

Press **Retry from the failing step**, the filled button in the header. It continues the run from the step where it stopped, with everything it already did kept. In the Admin view, **Retry from step…** re-runs from an earlier step. An interrupted run (for example after a restart) can be retried the same way; a watcher does this by itself. **Stop this change…** stops one that is still going; it asks first.

### 6. Approve a waiting change

A change that waits at an approval step shows **You** in **What happens next**. Press **Approve** or **Reject**; both open a dialog with an optional note. For a GitHub flow you can also comment `/approve` or `/reject` on the issue.

### 7. Go back to a safe point

A safe point is a recent version that a successful run or a release left green. Open the repository page: Advanced lists them under **Safe points**, Simple under **Versions that worked**. **Restore** first shows what would be taken back, and what a restore does not undo: data the app wrote, messages already sent and settings in outside services. **Yes, open the change** opens one issue that takes the code back with new commits, built and tested like any other change. Nothing is reset or force-pushed.

### 8. Or use the command line

```bash
scf resume <run-id>
scf resume <run-id> --from <step>
scf approve <run-id> --note "…"
scf reject <run-id>
```

For a closed issue these commands refuse and say "Use --force to resume it anyway."; `--force` continues anyway.

## Check that it worked

- The change's status is *queued* or *working* again, and the header shows "resumed N×".
- On a watched issue the label becomes `factory:working` (or your own name for it) at the next check.
- The item leaves **Needs you** on Today.

## Next steps

- [Answer questions and approve risky plans](/how-to/approve-and-answer/)
- [Troubleshoot the Foundry](/how-to/troubleshoot/)
- [When something goes wrong, in the user guide](/guide/#when-something-goes-wrong)
- [Restore a safe point, in the user guide](/guide/#restore-a-safe-point)
