---
title: "How to work with gitflow and the daily release"
description: "Set up develop, feature branches and the daily release pull request to main, and know what happens to bug fixes when hotfixes are on."
slug: daily-release
order: 5
group: "Daily work"
time: "PT15M"
---

This page is for admins and repository owners who use the gitflow pipeline. Each story is built on its own feature branch and merged into `develop` by the Foundry. Once a day you get one pull request from `develop` to `main`. Merging it is the only step of the release that needs you.

## Before you start

- An issues watcher follows the repository with the flow `issue-gitflow`.
- The repository has a `develop` branch. If it is missing, the Foundry creates it from `main` the first time.
- `develop` is not in **Protected branches** (**Administration** → **Settings** → **Safety**), because the Foundry pushes to it. `main` stays protected.
- You are an admin, to add a watcher.

## Steps

### 1. Add the daily release watcher

Open **Administration** → **Watchers** → **Add watcher**. Choose the repository, the source **Schedule** and the flow `release-daily`. Set **Once a day at** `17:00` with your time zone. For a schedule, the text becomes the run's task, for example "Daily release pull request develop → main".

### 2. Let the stories go into develop

You do nothing here. Every issue gets its own branch, `feature/<issue>-<title>`, from `develop`. When its tests and reviews pass, the Foundry merges it into `develop` itself, runs the tests on the merged `develop`, pushes, deletes the merged feature branch and closes the issue. If `develop` moved meanwhile, it merges again; an agent resolves conflicts and the tests run again. Stories that change different parts of the code are built at the same time.

A finished story has the status "in develop (ships with the 17:00 release)" and, on GitHub, the label `Factory_done`.

### 3. Merge the release pull request

Every day at the set time, `release-daily` runs the full tests and build on `develop` and opens (or updates) one pull request `develop` → `main`. It lists and closes the day's issues. When the checks pass, the pull request shows under **Needs you** on **Home**, and its comment starts with **What you need to do:** Merge the release pull request when you like. Merge it on GitHub.

### 4. Handle a draft release pull request

When the daily tests or build fail, the pull request stays a draft. Its comment starts with **Nothing needed from you** — it stays a draft until the checks pass, and holds the failing output. It becomes ready again when a later run passes.

### 5. Decide whether bug fixes skip the release

An admin can switch on **Hotfixes** in **Administration** → **Settings** → **Safety** (off by default). Then an issue with a label from `hotfix_labels` (default `bug`) is built as a hotfix:

- The branch is `hotfix/<issue>-<title>`, made from `main`.
- After the reviews the Foundry merges it into `main`, runs the tests on the result, and pushes `main` only when they pass. The issue is closed at once.
- Then `main` goes into `develop`, so the next release has no conflicts from hotfixes.

If you use branch protection on GitHub, allow the Foundry's account to push to `main`. Without the setting, a bug story is built as a normal feature.

### 6. Merge main into develop when asked

If `develop` cannot take a hotfix, the fix is still on `main` and the comment on the issue starts with **What you need to do:** Merge main into develop, because the fix is not there yet. The Foundry tries again before the next story. To be sure, merge `main` into `develop` yourself; until then the release pull request can show conflicts.

## Check that it worked

- After the release time, **Home** shows the release pull request under **Needs you**.
- After you merge it, the "Since you last looked" strip lists it under **Releases to main**.
- Feature branches of finished stories are gone from the repository.

## Next steps

- [Follow your work on Home and the board](/how-to/board/)
- [Keep the Foundry safe](/how-to/safety/)
- [Branches: gitflow in the user guide](/guide/#branches-gitflow-recommended-or-one-rolling-pull-request)
- [The label pipeline](/guide/#the-label-pipeline-one-label--plan--code--one-pull-request)
