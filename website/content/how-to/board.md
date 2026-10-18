---
title: "How to follow your work on Home and the board"
description: "Read Home, the board and the health line to see where every story is, who has the next move, and whether the Foundry itself is well."
slug: board
order: 6
group: "Daily work"
time: "PT10M"
---

This page is for anyone who wants to know where their work is without asking. **Home** tells you what waits for you. The **Board** shows where every story is and why, like a parcel tracker. The health line says when something is wrong with the Foundry itself. A short look at the three is enough for a normal day.

## Before you start

- You can sign in to the Foundry.
- At least one watcher follows a repository, or you have started runs yourself.
- Admins see more than users: costs, owners, the health line and other accounts. Users see only their own work.

## Steps

### 1. Start on Home

Open **Home**. The top shows the counts, for example "2 need you · 1 active", and one button: the first thing that needs you, then a problem, then an active run, else **Start work**. Below it:

- **Needs you** — questions, approvals, failed or stopped work, a release pull request to merge, a watcher with an error.
- **Active** — work that is running or queued; each row says what happens next.
- **Problems** (admins) — problems of the Foundry that Needs you does not already show.
- **Recently completed** and **Metrics** (admins) — closed until you open them.

Home asks again every 30 seconds. The number of waiting items also shows in the tab title, for example "(3) Foundry".

### 2. Read "Since you last looked"

After a break of 30 minutes or more, a strip under the header sums up what changed: **Stories done**, **Merged into develop**, **Releases to main**, **Failed** and **Newly waiting for you**. **Dismiss** hides it.

### 3. Open the board

Open **Board**. There is one board per repository; with several repositories you get tabs. The columns are:

*Your turn*, *Waiting for another story*, *Queued*, *Planning*, *Coding*, *Reviewing*, *Merging*, *Done* and *Failed*.

*Merging* also holds finished work that waits for the scheduled release. *Done* is grouped by Today and This week. The page asks every 5 seconds.

### 4. Read a card

A card shows the issue number and title, what happens next, the current step ("coding — step 12 of 29") and the stories it waits for ("after #88"). A bug story has a "goes first" mark. Click the card to open its run page. Every status has a **?** that tells you what it means and what happens next.

### 5. See who has the next move

Use "What is in the way of #89?" to mark the whole chain of stories that holds one back; **Show all** clears it. Admins find the **Waiting** card on the **Dashboard**: every labelled issue that is not being worked on, each starting with a badge for who has the next move — **You**, **Foundry**, **Another story**, **A time limit** or **Something is wrong**. Lines where you have the next move come first.

### 6. Check the health line

Under the top bar of the admin display, the health line says **All good**, or the number of problems of the Foundry itself, one line each: who has the next move, what to do, why, and a link to the place to act. Examples are a waiting restart, a usage limit, a watcher error or a run that failed because of the Foundry. Press the health chip to open or close it.

### 7. Or look from the command line

```bash
scf login
scf turn list
scf board
```

`scf turn list` shows what waits for you. An area without an action, such as `scf board`, lists its commands.

## Check that it worked

- Home says "Nothing needs you." when nothing waits, or lists each item with one button.
- Each story you labelled has a card in one column of the board.
- The health line says **All good**.

## Next steps

- [Answer questions and approve risky plans](/how-to/approve-and-answer/)
- [Resume or retry a run](/how-to/resume-run/)
- [Home, the board and the health line in the user guide](/guide/#3-follow-approve-and-resume-runs)
- [Why is nothing happening?](/guide/#why-is-nothing-happening)
