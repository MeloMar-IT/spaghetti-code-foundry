---
title: "How to upgrade from claude-factory"
description: "Move an existing claude-factory install to Spaghetti Code Foundry: new remote, new scf command, new data folder and a refreshed login service."
slug: upgrade-from-claude-factory
order: 7
group: "Get started"
time: "PT15M"
---

This page is for you if you already run claude-factory, the old name of Spaghetti Code Foundry. The command is now `scf` (`factory` still works), the repository is `MeloMar-IT/spaghetti-code-foundry` and the data folder is `~/.spaghetti-code-foundry`. Most of the move happens by itself; you point your clone at the new address, link the new command and refresh the login service.

## Before you start

- An existing clone of claude-factory on your Mac.
- No run is running. The data move waits while a run is running.
- Enough free disk space for a copy of `~/.claude-factory` (its size plus 10 % plus 100 MiB).
- Stop old `factory watch` processes. They run old code and cannot join the lock the move uses.

What keeps the old name: the `.claude-factory/` folder inside each repository, the labels (`claude-factory`, `factory:*`) and the `factory/…` branches.

## Steps

### 1. Point your clone at the new repository

GitHub redirects the old address, but point your clone at the new one:

```bash
git remote set-url origin https://github.com/MeloMar-IT/spaghetti-code-foundry.git
```

```bash
git remote -v
```

The folder of your clone can keep its name.

### 2. Build the new version

Bring your clone up to date with the new version, then build it:

```bash
npm install
```

```bash
npm run build
```

### 3. Link the scf command

If `factory` still points at the old install, run this in the repository:

```bash
npm unlink -g claude-factory && npm link
```

### 4. Start the Foundry to move the data folder

```bash
scf ui
```

On the first start of any `scf` command except help, the whole `~/.claude-factory` folder is copied to `~/.spaghetti-code-foundry`: config, runs, flows, blocks, learnings, queue, locks and evals. Paths that point into the old folder are rewritten. Runs that use a git worktree are repaired, so a waiting run can be approved and resumed in the new folder. A running server on the old folder restarts onto the new one when it is idle.

The move waits if you set `SCF_HOME` or `FACTORY_HOME`, if the new folder already exists, or while a run is running. It is tried again on later starts.

### 5. Create the admin account if you have none

If your old version had no sign-in, the first visit to the UI shows **Create the admin account**. Do this once; nothing else changes. You can also run:

```bash
scf user create --admin
```

### 6. Refresh the login service

```bash
scf service install
```

This moves the service's log and settings to the new folder, and replaces the old `com.claude-factory.server` agent with `com.spaghetti-code-foundry.server`. Check it:

```bash
scf service status
```

### 7. Clean up when everything works

`~/.claude-factory` is never changed or deleted, except for a note file `MOVED-TO-SPAGHETTI-CODE-FOUNDRY.txt`. Nothing there is used any more. You can delete the folder once everything works.

## Check that it worked

- `~/.spaghetti-code-foundry` exists, and your settings are in `~/.spaghetti-code-foundry/config.yaml`.
- The old folder holds the note file `MOVED-TO-SPAGHETTI-CODE-FOUNDRY.txt`.
- Your earlier runs show under **Runs**, and your watchers show on **Administration** → **Watchers**.
- `scf service status` no longer says that `scf service install` is needed.

If `scf` refuses to run because the new folder is missing, restore it, set `SCF_HOME` to the folder you want, or delete the note file to copy again.

## Next steps

- [Keep the Foundry running as a login service](/how-to/run-as-service/)
- [Troubleshoot the Foundry](/how-to/troubleshoot/)
- [User guide: Upgrading from claude-factory](/guide/#11-upgrading-from-claude-factory)
- [User guide: Watchers move from config.yaml to their repositories](/guide/#watchers-move-from-configyaml-to-their-repositories)
