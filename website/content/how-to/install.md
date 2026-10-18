---
title: "How to install Spaghetti Code Foundry on your Mac"
description: "Install Spaghetti Code Foundry from source on macOS, link the scf command, start the web UI and create the first admin account."
slug: install
order: 1
group: "Get started"
time: "PT15M"
---

This page is for you if you want to run Spaghetti Code Foundry (SCF) on your own Mac. The Foundry is built and used on macOS. At the end you have the `scf` command, the web UI at `http://localhost:4777` and an admin account to sign in with.

## Before you start

- A Mac.
- Node.js 20 or newer, and git.
- [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`), logged in.
- [GitHub CLI](https://cli.github.com) (`gh`), logged in. You need it for the GitHub flows.
- Optional: Codex CLI for Codex steps (the shipped flows use it for reviews), Ollama or LM Studio for local models, and Docker for sandboxed test runs.

## Steps

### 1. Clone the repository

```bash
git clone https://github.com/MeloMar-IT/spaghetti-code-foundry.git
```

```bash
cd spaghetti-code-foundry
```

### 2. Install the dependencies and build

```bash
npm install
```

```bash
npm run build
```

The build compiles the TypeScript sources to `dist/`.

### 3. Link the scf command

```bash
npm link
```

This gives you the `scf` command. The old name `factory` still works as an alias. If you linked the old name `claude-factory` before, run `npm rm -g claude-factory` first.

If you prefer not to use `npm link`, put a link to the program on your path instead:

```bash
ln -s "$PWD/dist/cli.js" ~/.local/bin/scf
```

### 4. Start the web UI

Go to the repository you want to work on and start the UI from there:

```bash
cd ~/code/my-project
```

```bash
scf ui
```

The UI opens at **http://localhost:4777**. By default it only listens on your own machine. The path in the top-right corner is the repository that runs work on by default. Use `scf serve` instead if you do not want a browser to open.

### 5. Create the admin account

The first time you open the UI there is no account yet, so it shows **Create the admin account**. Enter a name, an e-mail and a password twice. The password needs 12 to 200 characters and must not be a common one. This signs you in.

You can also create the admin in a terminal:

```bash
scf user create --admin
```

The name and e-mail are asked for on the terminal, and the password is asked twice. While there is no admin, `scf ui` and `scf serve` print a hint.

### 6. Sign in

After that, the UI shows a sign-in form. Your name and a **Sign out** button are in the top bar. You stay signed in for 7 days, or until you sign out.

## Check that it worked

- `scf ui` opens the web UI at `http://localhost:4777`.
- After you sign in, the app opens on **Home**, and the sidebar shows **Work** (Home, Board, Epics, Refinement, Runs, Repositories) and **Setup** (Flows, Administration).
- The health line under the top bar says "All good", or names what is wrong with the Foundry itself.
- `scf user list` lists your admin account with its last sign-in.

If you forget the password later, run `scf user password <e-mail>` on the machine.

## Next steps

- [Run your first flow by hand](/how-to/first-run/)
- [Let the Foundry build your GitHub issues](/how-to/github-issues/)
- [Keep the Foundry running as a login service](/how-to/run-as-service/)
- [User guide: Start](/guide/#1-start)
