---
title: "How to answer questions and approve risky plans"
description: "Answer the Foundry's questions and decide on risky plans and splits, from Home or on the GitHub issue, so your stories keep moving."
slug: approve-and-answer
order: 1
group: "Daily work"
time: "PT10M"
---

This page is for anyone whose issues the Foundry builds. The Foundry works by itself, but it stops for a person in a few places: questions only you can answer, plans that are risky, and splits of issues that are too big. Here you learn where those show up and how to answer them, in the app or on GitHub.

## Before you start

- The Foundry runs (`scf ui` or `scf serve`) and you can sign in.
- An issues watcher follows your repository, for example with the flow `issue-gitflow` and the label `Factory_go`.
- To approve or reject on GitHub, you need write access to the repository.

## Steps

### 1. Open Home and look at Needs you

Open **Home**. The top shows the counts, for example "2 need you · 1 active", and one button for the best next step. **Needs you** lists only what waits for you: questions, approvals, failed or stopped work, a release pull request to merge, and a watcher that has an error. The item that holds back the most stories comes first. When nothing waits, Home says "Nothing needs you."

### 2. Answer the questions

A story with questions has the status "waiting for you — questions" and the label `Factory_needs_info` on GitHub. On Home, press **Show questions**:

- **Accept all recommendations** takes the recommended answer for every question (only for questions asked up front).
- **Answer…** opens a box per question. Each needs an answer. **Use recommendation** fills one in.

On GitHub you can reply on the issue in your own words, or reply `/defaults` to go with the recommendations. Both ways continue by themselves.

### 3. Read the risk score of a plan

Every plan gets a risk score from 0 to 100. Opus and Codex each give one; the higher one counts.

| Score | Typical change |
|---|---|
| 0–25 | local, well covered by tests, easy to undo |
| 26–50 | several modules, or behaviour users see |
| 51–75 | persistence or migrations, concurrency, public APIs or file formats, hard to test |
| 76–100 | security or trust, installing or deleting software or user data, irreversible steps, privacy, or assumptions the planner could not verify |

Above 75 a person decides. The plan is posted on the issue with the score and the reason, and the issue gets `Factory_waiting`. The threshold is the watcher variable `risk_threshold` (default 75). Add `Factory_review_plan` to an issue if you always want to approve its plan yourself.

### 4. Approve or reject

On Home, press **Show plan**, **Show split** or **Show request**. You see the risk and two buttons:

- **Approve** starts the coding (or creates the smaller issues of a split).
- **Reject** asks you to say what to change. The Foundry then plans again with your feedback.

On GitHub, reply `/approve` (you may add notes) or `/reject` followed by what to change. Each action from Home is a normal comment on the issue under the Foundry's GitHub login, signed with your name. The item then moves to **Done — continuing**.

### 5. Decide on runs you started yourself

An approval step in a flow you ran by hand waits on its run page. Press **Approve** or **Reject** there, or use the command line:

```bash
scf approve <run-id> --note "Looks good"
scf reject <run-id>
```

### 6. Hide what you will handle later

**Dismiss** hides an item until its situation changes. **Show again** at the bottom of the list brings dismissed items back. Watcher errors cannot be dismissed.

## Check that it worked

- The item leaves **Needs you** and shows under **Done — continuing**.
- On GitHub the `Factory_needs_info` or `Factory_waiting` label goes, and the status comment on the issue says **Nothing needed from you**.
- The story moves on the **Board**, for example from *Your turn* to *Coding*.

## Next steps

- [Resume, retry or approve a run that stopped](/how-to/resume-run/)
- [Follow your work on Home and the board](/how-to/board/)
- [Labels the Foundry sets and what you do](/guide/#how-do-i)
- [The risk score in the user guide](/guide/#the-risk-score)
