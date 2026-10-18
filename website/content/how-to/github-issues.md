---
title: "How to let the Foundry build your GitHub issues"
description: "Add an issues watcher with the issue-gitflow flow and the Factory_go label, so labelled issues are planned, coded, tested and merged into develop."
slug: github-issues
order: 3
group: "Get started"
time: "PT15M"
---

This page is for admins who want the Foundry to work through GitHub issues on its own. You add one watcher, put one label on an issue, and the Foundry asks its questions, plans, codes, tests, reviews and merges the story into `develop`. You step in only to answer questions, approve risky plans and merge one release pull request a day.

## Before you start

- The Foundry is installed and you are signed in as an admin (see [Install](/how-to/install/)).
- The GitHub CLI (`gh`) is logged in on this Mac. Check it with `gh auth status`.
- The repository is added under **Repositories** with the sign-in "The server's own access", a GitHub token or the GitHub App. A deploy key cannot have a watcher (see [Connect a repository](/how-to/connect-repository/)).
- `develop` is not in **Protected branches** under **Administration** → **Settings**, because the Foundry pushes to it. `main` stays protected.

## Steps

### 1. Open the Watchers page

Go to **Administration** → **Watchers** and press **Add watcher**. You can also open the repository's own page and use **+ Add watcher** in its **Watchers** section.

### 2. Fill in the watcher

- **Repository:** choose your repository (`owner/repo`) from the list. There is no owner field; the repository's owner owns the runs.
- **Flow:** `issue-gitflow`.
- **Label:** `Factory_go`.

The options are in three groups, collapsed by default: **Labels**, **Dependencies** and **Comments**. Each control shows its default. Under **Comments** you can set a questions check; the built-in `epic-questions` flow asks every open question for all new issues up front.

### 3. Add a daily release watcher

Add a second watcher with the source **Schedule**, the flow `release-daily` and **Once a day at** a time such as `17:00` with your time zone. Its text becomes the run's task, for example "Daily release pull request develop → main". Once a day it runs the full tests and build on `develop` and opens one pull request from `develop` to `main`.

### 4. Make sure the Foundry keeps running

Watchers only run while `scf ui` or `scf serve` runs. To keep it going after you close the terminal, install the login service:

```bash
scf service install
```

### 5. Put the label on an issue

On GitHub, add `Factory_go` to an issue, or to a whole batch of issues. Give stories a **Depends on** section so they are built in order.

### 6. Answer questions and approve risky plans

Open **Home**. Questions and risky plans show up there, one button each. You can also act on the issue itself:

- Reply to the questions, or reply `/defaults` to accept the recommendations.
- A plan with a risk score above 75 waits for you. Reply `/approve` (with notes if you like) or `/reject` with what to change.

### 7. Let the stories run, and merge the release

Each issue gets its own branch, `feature/<issue>-<title>`, from `develop`. If the repository has no `develop` branch, the Foundry creates it from `main`. When the tests and the reviews pass, the Foundry merges the branch into `develop`, runs the tests on the merged `develop`, pushes and closes the issue. Issues that change different parts of the code are built in parallel. An issue that is too big is split into smaller ones.

Once a day the release pull request from `develop` to `main` shows up under **Needs you** on **Home**. You merge it.

## Check that it worked

- The issue gets a status label, such as `factory:working`, and one status comment that says what happens next.
- The watcher's card on the **Watchers** page shows **last successful check**. Press **Check now** to check at once.
- The story shows on the **Board**, and its run shows under **Runs**.
- If nothing happens, look at the health line and at the **Waiting** card on the **Dashboard**.

## Next steps

- [Approve plans and answer questions](/how-to/approve-and-answer/)
- [Merge the daily release](/how-to/daily-release/)
- [Follow stories on the board](/how-to/board/)
- [User guide: Why is nothing happening?](/guide/#why-is-nothing-happening)
