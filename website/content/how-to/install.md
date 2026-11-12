---
title: "How to install Spaghetti Code Foundry on your Mac"
description: "Install the Foundry from source on macOS, start the web UI, create the admin account, run the Setup check and invite people who are not engineers."
slug: install
order: 1
group: "Get started"
time: "PT15M"
---

This page is for you if you want to run Spaghetti Code Foundry (SCF) on your own Mac. The Foundry is built and used on macOS. At the end you have the `scf` command, the web UI at `http://localhost:4777`, an admin account to sign in with, and a computer that passes the Setup check.

## Before you start

- A Mac.
- Node.js 20 or newer, and git.
- [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`), logged in.
- [GitHub CLI](https://cli.github.com) (`gh`), logged in. You need it for the GitHub flows.
- Optional: Codex CLI for OpenAI models (the shipped flows use it for reviews), Ollama or LM Studio for local models, and Docker for sandboxed test runs.

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

### 4. Start the web UI

Go to the repository you want to work on and start the UI from there:

```bash
cd ~/code/my-project
```

```bash
scf ui
```

The UI opens at **http://localhost:4777**. By default it only listens on your own machine. In the Admin view, the path at the bottom of the sidebar is the repository runs work on by default. Use `scf serve` instead if you do not want a browser to open.

### 5. Create the admin account

![The sign-in form](../../docs/images/sign-in.png)

The first time you open the UI there is no account yet, so it shows **Create the admin account**. Enter a name, an e-mail and a password twice. The password needs 12 to 200 characters and must not be a common one. This signs you in.

You can also create the admin in a terminal with `scf user create --admin`. While there is no admin, `scf ui` and `scf serve` print a hint. After that, the UI shows a sign-in form. You stay signed in for 7 days. **Sign out** is in the account menu at the right of the top bar.

### 6. Run the Setup check

![The Setup check: what this computer still needs](../../docs/images/setup-check.png)

Open **Setup check** with **Search** (type "Setup") or at `#/setup`. It checks git, Claude Code and whether it is signed in, and Codex (optional). Each item shows a green tick, or a plain explanation with one command to copy. Fix what is missing and press **Check again**. Only admins can open it. The page never asks for a password or a key. In a terminal, `scf doctor --simple` prints the same check.

The next step is **Claude and Codex** (`#/agents`): six plain questions about which tools and plans you have and how they share the work.

### 7. Choose your view

The account menu has a **View** box. **Admin** (the default for an admin) shows Today, Changes, Ideas, Releases and Help, plus Board, Repositories, Flows and Administration. **Advanced** is the user display. **Simple** shows your projects in plain words, with no logs, costs or branch names. **Appearance** in the same menu sets the theme, the density and the look: Calm, Midnight, Friendly, Editorial or Bento.

### 8. Invite someone who is not an engineer

Open **Administration** → **Users** and press **+ Add user**. Tick **Simple account**: it sets the role to user and the Simple view. The dialog shows a set-password link. Send it to the person yourself; it works once, for 24 hours. After they set a password and sign in, the **Get started** guide opens at its first step, **Welcome**. At the steps that need an admin, the guide tells them to ask you.

## Check that it worked

- `scf ui` opens the web UI at `http://localhost:4777`, and you land on **Today**.
- The sidebar shows **Today**, **Changes**, **Ideas**, **Releases** and **Help**, and **+ New change** is in the top bar.
- The Setup check shows a green tick for every item you need.
- The health chip in the top bar says **All good**, or names what is wrong with the Foundry itself.
- `scf user list` lists your admin account with its last sign-in.

If you forget the password later, run `scf user password <e-mail>` on the machine.

## Next steps

- [Run your first change](/how-to/first-run/)
- [Let the Foundry build your GitHub issues](/how-to/github-issues/)
- [Keep the Foundry running as a login service](/how-to/run-as-service/)
- [User guide: Simple, Advanced and Admin view](/guide/#simple-advanced-and-admin-view)
