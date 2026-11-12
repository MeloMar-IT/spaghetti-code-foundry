---
title: "How to follow your work on Today and the board"
description: "Read Today, the board and the health chip to see where every change is, who has the next move, and whether the Foundry itself is well."
slug: board
order: 6
group: "Daily work"
time: "PT10M"
---

This page is for anyone who wants to know where their work is without asking. **Today** tells you what waits for you and what is being built. **Changes** lists every change. In the Admin view, the **Board** shows where every change of a repository is and why, like a parcel tracker, and the health chip says when something is wrong with the Foundry itself.

## Before you start

- You can sign in to the Foundry.
- At least one watcher follows a repository, or you have started changes yourself.
- The Board, the health chip, costs and other accounts are only in the Admin view. In the Advanced and Simple views you see only your own work.

## Steps

### 1. Start on Today

![Today in the Admin view: what needs you, the four counters and what is being built](../../docs/images/home.png)

Open **Today** in the sidebar; the app opens there. It starts with a greeting and one summary line, then:

- **Needs you** — one card for each item that waits for you, with one main button. **See what happened** opens the technical cause.
- **Four counters** — **Waiting**, **Building**, **Needs your check** and **Finished today**. Each one opens **Changes** with that list.
- **Building now** — each change with its five phases (**Understand**, **Plan**, **Build**, **Check**, **Deliver**) and one sentence on what is happening.
- **Finished recently** — plain titles, with **Show all**.

The Admin view adds **Your turn**, **Since you last looked**, **Problems** and **Metrics** below. The number of waiting items shows on **Today** in the sidebar and in the tab title, for example "(3) Foundry".

### 2. In the Simple view, read My projects

![Today in the Simple view of a user](../../docs/images/user-home.png)

Simple shows **My projects**: counters for **Needs you**, **Running**, **Ready to check** and **Published this week**, then one card per project with its state and one button. The layout follows your look: cards, tiles or a list. Open a project to see **What you need to do** and **What is being made**.

### 3. Read "Since you last looked"

In the Admin view, after a break of 30 minutes or more, a box on Today sums up what changed: **Stories done**, **Merged into develop**, **Releases to main**, **Failed** and **Newly waiting for you**. **Dismiss** hides it.

### 4. Open the board

![The board of a repository](../../docs/images/board.png)

In the Admin view, open **Board** in the sidebar, below the divider. There is one board per repository; with several repositories you get tabs. The columns are *Your turn*, *Waiting for another story*, *Queued*, *Planning*, *Coding*, *Reviewing*, *Merging*, *Done* and *Failed*. *Merging* also holds finished work that waits for the scheduled release. The page asks every 5 seconds.

### 5. Read a card

A card shows the issue number and title, what happens next, the current step ("coding — step 12 of 29") and the changes it waits for ("after #88"). A bug story has a "goes first" mark. Click the card to open the change's page. "What is in the way of #89?" marks the whole chain that holds one back; **Show all** clears it.

### 6. Check the health chip

In the Admin view, the top bar has a health chip. It reads **All good**, or the number of problems of the Foundry itself, and turns red when there is one. Press it to open the health line: one entry per problem, with who has the next move, what to do, why, and a link to the place to act.

### 7. Or look from the command line

```bash
scf login
scf turn list
scf runs list --status failed
```

`scf turn list` shows what waits for you.

## Check that it worked

- Today says "Nothing needs you" when nothing waits, or lists each item with one button.
- Each change you started or labelled shows under **Changes**, and in the Admin view as a card on the board.
- The health chip says **All good**.

## Next steps

- [Answer questions and approve risky plans](/how-to/approve-and-answer/)
- [Resume or retry a run](/how-to/resume-run/)
- [Today, the board and the health line in the user guide](/guide/#3-follow-approve-and-resume-runs)
- [Why is nothing happening?](/guide/#why-is-nothing-happening)
