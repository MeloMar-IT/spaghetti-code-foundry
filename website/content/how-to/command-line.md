---
title: "How to use the Foundry from the command line"
description: "Sign in with scf login, list runs and what waits for you, script with --json, and make any server call with scf api from your terminal."
slug: command-line
order: 6
group: "Get started"
time: "PT10M"
---

This page is for you if you prefer a terminal, or want to script the Foundry. Everything the web interface does goes through the server's API, and every call of that API is also a command. These commands talk to the running Foundry with your account and its rights.

## Before you start

- The Foundry is installed and running, with `scf ui`, `scf serve` or the login service (see [Run as a service](/how-to/run-as-service/)).
- You have an account on that Foundry, admin or user.
- Older commands such as `scf run`, `scf resume` and `scf user` work on the files of the data folder and need no server. They are not covered here.

## Steps

### 1. Sign in

```bash
scf login
```

It asks for your e-mail address and password. The password is typed without echo and is not kept; only the session is kept, in `cli-session.json` in the data folder, readable by your user only. The session ends after 7 days, at `scf logout`, or when your password changes. To sign in to another Foundry, add `--server foundry.example.com`; any address other than this machine is reached over HTTPS.

### 2. Check who you are

```bash
scf whoami
```

### 3. See what waits for you

```bash
scf turn list
```

The `turn` area covers what waits for you, and answering it: answers, defaults, approve, reject and retry.

### 4. List and filter runs

```bash
scf runs list --status failed
```

The `runs` area lists, shows, starts, answers, approves, rejects, resumes, cancels and archives runs, and shows a step's log and the diff. Other areas are `board`, `find`, `repos`, `refine`, `ask`, `flows`, `blocks`, `settings`, `providers`, `monitor`, `users`, `admin`, `audit`, `account`, `secrets`, `watchers` and `server`.

### 5. Find the commands of an area

An area without an action lists its commands:

```bash
scf repos
```

Add `--help` to see the options of one command:

```bash
scf runs list --help
```

### 6. Use it in scripts

- `--json` prints the server's answer as it is. Without it you get a table or a few lines.
- `--data '{…}'` or `--data @file.json` adds fields that have no option of their own.
- Exit code 0 means done; 4 means not signed in or not allowed; 1 is any other refusal.
- A command that deletes or replaces something asks you to type `yes`. `--yes` answers for you.
- A password, token or other secret is never an option or an argument. The command asks for it without echo, so it is not in your shell history.

### 7. Make any call directly

List every call the server knows, and who may make it:

```bash
scf api routes
```

Add a word to narrow the list, for example `scf api routes runs`. Then make a call:

```bash
scf api GET runs
```

`POST`, `PUT`, `PATCH` and `DELETE` work too. A body is sent only with `--data`. `DELETE`, `PUT` and `PATCH` ask you to type `yes` first.

### 8. Sign out

```bash
scf logout
```

## Check that it worked

- `scf whoami` shows your account and the Foundry you are signed in to.
- `scf runs list` prints the same runs you see under **Runs** (or **My runs** for a user) in the web UI.
- In a script, the exit code is 0 when a command succeeded, and 4 when you are not signed in or not allowed.

## Next steps

- [Approve plans and answer questions](/how-to/approve-and-answer/)
- [Resume a run that stopped](/how-to/resume-run/)
- [User guide: The command line for a running Foundry](/guide/#the-command-line-for-a-running-foundry)
- [User guide: Command line](/guide/#9-command-line)
