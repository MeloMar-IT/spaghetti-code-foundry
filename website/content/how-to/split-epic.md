---
title: "How to hand the Foundry a whole epic"
description: "Label a batch of stories at once, set the build order with Depends on, and let the Foundry split stories that are too big into smaller ones."
slug: split-epic
order: 3
group: "Daily work"
time: "PT20M"
---

This page is for you when you have more than one story to build: an epic, a feature in several steps, or a backlog you want worked through. You put one label on all of them. The Foundry asks its questions up front, builds the stories in the order you set, and splits a story that is too big for one change.

## Before you start

- An issues watcher follows the repository with the flow `issue-gitflow` and the trigger label `Factory_go` (the names on this page are those of the example configuration).
- The watcher has the questions check `epic-questions` (the watcher option `precheck_flow`, or **Comments** → questions check in the form).
- Your stories are open GitHub issues in that repository.

## Steps

### 1. Set the build order with Depends on

Give each story that needs another one first a **Depends on** (or **Blocked by**) section. Name the issues as `#72`, or by title:

```
### Depends on
- #72
- Story 4 — Download the update safely
```

A story with such a section starts only when those issues are done: closed, or labelled with a `dependency_done_labels` label such as `Factory_done`. This is the watcher option `wait_for_dependencies`, on by default. Each story is then planned and coded on top of the code of the one before it.

### 2. Label the whole batch

In GitHub's issue list, select all the stories, then **Labels** → `Factory_go`. Add `Factory_review_plan` to any story whose plan you want to approve yourself, whatever its risk.

### 3. Answer the questions once

New issues are first checked together for questions only you can answer. You see them under **Needs you** on **Home**, and on each issue with the label `Factory_needs_info`. Answer them there, or reply `/defaults` on the issue to take the recommendations. Then each story is planned right before it is coded.

### 4. Let the Foundry split stories that are too big

A plan over 15 files or about 800 lines of production code (tests and docs do not count) is split into smaller issues instead. The planner proposes the split and gives it a **split risk** from 0 to 100.

- **Split risk 50 or lower:** the Foundry creates the new issues by itself, with the original's labels, `Factory_go`, and a **Depends on** section with the real issue numbers. It comments the list on the original and closes it.
- **Above 50**, or the issue has `Factory_review_plan`: the split waits on the issue (`Factory_waiting`). Reply `/approve` to create the issues, or `/reject` followed by what to change. On Home, **Show split** gives you the same choice.

If you already agreed to a split in a comment ("split it"), the issues are created without asking. The limits are the watcher variables `max_files`, `max_code_lines` and `auto_split_max_risk`.

### 5. Follow the epic

Open **Epics** and choose the repository. Each row shows a progress bar, how the epic grew ("Stories: 21 at the start, 95 now (16 were split)"), the expected finish and what holds it up. Click the epic's name for its page: the critical path, the stories in build order and the dependency chains. When there is not enough history, the row says **Too early to say**.

### 6. Find what blocks a story

On the **Board**, a card says which stories it waits for ("after #88"). Use "What is in the way of #89?" to mark the whole chain that holds a story back. **Show all** clears it.

## Check that it worked

- Stories with open dependencies show in the column *Waiting for another story*, with the status "waiting for #88".
- Stories in different parts of the code are coded at the same time; stories in one **Depends on** chain are built one after the other.
- After an automatic split, the original issue is closed and the new issues show on the Board.

## Next steps

- [Answer questions and approve splits](/how-to/approve-and-answer/)
- [Turn ideas into ready stories with Refinement](/how-to/refine-ideas/)
- [Issues that are too big, in the user guide](/guide/#issues-that-are-too-big)
- [The Epics page in the user guide](/guide/#epics)
