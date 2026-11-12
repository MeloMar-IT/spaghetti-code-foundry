---
title: "How to answer questions, check a change and approve risky plans"
description: "Answer the Foundry's questions, correct its assumptions, try its checks with Works or Not quite, and approve or reject risky plans, from Today or GitHub."
slug: approve-and-answer
order: 1
group: "Daily work"
time: "PT10M"
---

This page is for anyone whose changes the Foundry builds. The Foundry works by itself, but it stops for a person in a few places: questions only you can answer, plans that are risky, changes that wait for your check, and splits of issues that are too big. Here you learn where those show up and how to answer them, in the app or on GitHub.

## Before you start

- The Foundry runs (`scf ui` or `scf serve`) and you can sign in.
- An issues watcher follows your repository, for example with the flow `issue-gitflow` and the label `Factory_go`, or you started a change with **+ New change**.
- To approve or reject on GitHub, you need write access to the repository.

## Steps

### 1. Open Today and look at Needs you

Open **Today**. The summary line says, for example, "1 thing needs you, 1 change is being built, 3 finished today". **Needs you** has one card for each item that waits for you, with the change's title, one sentence on what happened and one main button. When nothing waits, it reads "Nothing needs you". In the Admin view, the **Your turn** list below the cards has buttons to act right there.

### 2. Answer the questions

![Answering the Foundry's questions on a change's page](../../docs/images/user-questions.png)

A change with questions has the status "waiting for you — questions" and the label `Factory_needs_info` on GitHub. In the Admin view, press **Show questions** in Your turn:

- **Accept all recommendations** takes the recommended answer for every question (only for questions asked up front).
- **Answer…** opens a box per question. Each needs an answer. **Use recommendation** fills one in.

In the Simple view, press **Answer the questions** on the project page. Each question is a card in plain words; a button shows the suggestion, and a box takes your own answer. **Send my answers** sends them. On GitHub you can reply in your own words, or reply `/defaults`.

### 3. Check what was asked and what was assumed

Open the change and look at the **Your request** box on **Progress**. **You asked** lines come from the issue; **Assumed** lines are choices the planner made itself, with a dashed edge. Read the assumptions first. While the plan waits for a decision, **Change this** on an assumption opens a box; **Send correction** sends the plan back with your words, and the planner makes it again.

### 4. Read the risk score of a plan

Every plan gets a risk score from 0 to 100. Above 75 a person decides. 0–25 is local and easy to undo; 76–100 touches security, user data, irreversible steps, privacy, or assumptions the planner could not verify. The plan is posted on the issue with the score and the reason, and the issue gets `Factory_waiting`. Add `Factory_review_plan` to an issue if you always want to approve its plan yourself.

### 5. Try the checks, then approve or reject

![A change waiting for a decision, with Approve and Reject in its header](../../docs/images/run-waiting.png)

When a change waits for your check, its page shows **Checks to try**. Each row has **Try** (what to do) and **Expect** (what you should see). Press **Works** or **Not quite**. **Not quite** asks "What did you see?"; write one sentence and press **Send back**, and the change goes back with your words. **+ Add a check** adds a check of your own, which comes back in the next round.

Then press **Approve** or **Reject** in the header; both open a dialog with an optional note. The approve button says how many checks are not marked yet. In Your turn, **Show plan**, **Show split** and **Show request** give the same choice. In the Simple view, the card has **This is good** and **Something is not right**.

On GitHub, reply `/approve` (you may add notes) or `/reject` followed by what to change. Each action from the app is a normal comment on the issue under the Foundry's GitHub login, signed with your name.

### 6. Decide on runs you started yourself

An approval step in a run you started waits on its page with the same **Approve** and **Reject** buttons. In a terminal:

```bash
scf approve <run-id> --note "Looks good"
scf reject <run-id>
```

### 7. Hide what you will handle later

**Dismiss** hides an item until its situation changes, and the message offers **Undo**. **Show again** at the bottom of Your turn brings dismissed items back. Watcher errors cannot be dismissed.

## Check that it worked

- The item leaves **Needs you** and shows under **Done — continuing**.
- On GitHub the `Factory_needs_info` or `Factory_waiting` label goes, and the status comment says **Nothing needed from you**.
- The change moves on: its phase strip shows the next phase, and its card moves on the **Board**.

## Next steps

- [Resume, retry or approve a run that stopped](/how-to/resume-run/)
- [Follow your work on Today and the board](/how-to/board/)
- [Checks to try in the user guide](/guide/#checks-to-try)
- [The risk score in the user guide](/guide/#the-risk-score)
