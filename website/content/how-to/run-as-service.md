---
title: "How to keep the Foundry running as a login service"
description: "Install the Foundry as a macOS login service so watchers keep running after a restart, and learn how restarts and self-update work."
slug: run-as-service
order: 5
group: "Get started"
time: "PT10M"
---

This page is for admins who want the Foundry to keep working when no terminal is open. Watchers only run while `scf ui` or `scf serve` runs. On macOS you can install the Foundry as a login service, so it runs in the background and starts again after a restart of your Mac.

## Before you start

- The Foundry is installed and the `scf` command works (see [Install](/how-to/install/)).
- A Mac. The login service is for macOS.
- You are an admin of the Foundry. Self-update is switched on in Settings, which only an admin can change.
- For self-update only: the Foundry runs from a git checkout of its own repository, on `main`, with no local changes.

## Steps

### 1. Install the login service

```bash
scf service install
```

This runs `scf serve` in the background. The UI stays at `http://localhost:4777`, but no browser opens. If you installed the service with an older version, run this once more: it replaces the old `com.claude-factory.server` agent with `com.spaghetti-code-foundry.server`, and puts the old one back if the new one cannot start.

### 2. Check the service

```bash
scf service status
```

After an upgrade from claude-factory, `scf service status` also tells you when `scf service install` is still needed.

### 3. Know how a new build is picked up

When a new version is built with `npm run build`, the running server restarts itself as soon as no run is active. You do not need to stop and start it. To turn this off, set `SCF_NO_SUPERVISE=1`.

Some settings, such as **Listen on**, take effect only after a restart. After you save one, the Settings page says "A restart is needed" and offers **Restart when no story is running**.

### 4. Switch on self-update (optional)

Self-update is off by default, because it lets merged code run on this machine without a person looking. To switch it on, open **Administration** → **Settings** → **Safety** and name the Foundry's own repository. In `config.yaml` this is `self_update: { enabled: true, repo: owner/name }`. Then stop and start the Foundry once, so that it can go back after a bad update.

How it works:

- Every 5 minutes it checks whether `main` on GitHub has a new commit, and whether the checkout is on `main`, has no local changes and can fast-forward.
- It builds and tests the new commit in a separate folder (`npm ci`, `npm run build`, `npm test`). Failed tests are tried again after 20 minutes, up to 3 tries. The old version keeps running meanwhile.
- When all pass, no new runs start, and the server restarts when the active runs are done.
- If the new server stops or does not answer within 3 minutes, the previous version is put back once and reported.
- It never updates from a branch other than `main` or from another repository.

### 5. Remove the service if you need to

```bash
scf service uninstall
```

## Check that it worked

- `scf service status` reports the service.
- Close the terminal, then open `http://localhost:4777`. The UI still answers.
- On the **Watchers** page, each watcher shows a recent **last successful check**.
- With self-update on, the health line shows why it is waiting. When it says "Self-update is stopped", the checkout needs a person: run `git status`, `npm ci` and `npm run build`, then delete `self-update.json` in the data folder.

## Next steps

- [Let the Foundry build your GitHub issues](/how-to/github-issues/)
- [Use the command line](/how-to/command-line/)
- [Troubleshoot the Foundry](/how-to/troubleshoot/)
- [User guide: Keep it running](/guide/#keep-it-running)
