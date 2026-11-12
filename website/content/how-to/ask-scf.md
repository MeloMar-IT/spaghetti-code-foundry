---
title: "How to get help in the app with Ask Foundry"
description: "Switch on Ask Foundry, ask about the Foundry and your own work, check how sure an answer is, and know what the assistant will not do."
slug: ask-scf
order: 7
group: "Daily work"
time: "PT10M"
---

This page is for admins who want to switch on the help assistant, and for everyone who uses it. **Ask Foundry** answers questions in your own words: how the Foundry works, what your work is doing, and how to solve a problem. It reads and explains. Nothing you ask changes the Foundry, a repository or GitHub, unless you review and confirm an action yourself.

![The Ask Foundry panel, opened from the top bar](../../docs/images/ask.png)

## Before you start

- To switch it on, you are an admin in the Admin view.
- Ask Foundry answers with a **Claude Code** model (a local model that Claude Code can reach works too). With a Codex model every turn ends with "Ask Foundry is not set up to answer here."
- Do not type a password, token or key into a question. Ask Foundry never needs one.

## Steps

### 1. Check it before you switch it on (admins)

Run the fixed scenarios. Without `--live` no model is called.

```bash
scf eval help
```

### 2. Switch it on (admins)

Ask Foundry is off by default. Open **Administration** in the sidebar, then **Settings** under **System**, and turn on the switch on the **Ask Foundry** card (`help.enabled`). The limits are on the same card, for example the questions per account per day (default 30). To start small, set who may ask with `audience`: `admins` first, then `pilot` with `pilot_accounts`, then everyone. `scf ask usage` shows the stage you are in. **Pause Ask Foundry** is the emergency stop: nobody can ask, but conversations can still be read, exported and deleted.

### 3. Open the panel and ask

Press **Ask Foundry** in the top bar, between **Search** and **+ New change**. It is there in every view: Simple, Advanced and Admin. A panel opens on the right; the page behind it stays as it is. Type your question, or pick a suggested question and change it. Under the box you see what is sent: the address of the page you are on, and nothing else of the page. Untick **Send the page I am on with my question** to send the question alone. Press **Send**, or Ctrl+Enter (Cmd+Enter on a Mac). **Stop** stops an answer; **Try again** asks the same question again.

You can ask for product help, the status of your work, why something failed, and which steps solve a problem. In the Simple view, Ask Foundry answers in plain words, about your own projects only.

### 4. Check how sure the answer is

Read the line under the short answer first:

- **✓ Checked against its sources** — the answer rests on sources of the kind the question needs.
- **≈ Not fully confirmed** — the sources do not fully confirm it.
- **? Not checked: no source** — treat it as a guess.
- **! The sources do not agree** — look yourself before you act.
- **– Not answered** — you asked for something Ask Foundry does not do.

Then open **Sources and assumptions** and look at the places named there. A change's page or a repository page shows its own current state.

### 5. Know what it does not do

Ask Foundry does not start, stop, change, delete or send anything by itself. It sees only what your account can see, never another account's work. It does not read logs or transcripts. It sends you to the place that does the work: writing stories is done in **Ideas**, what happens next with a change is said on the change's own page, and the monitor's findings are on **Administration** → **Problems**. With `help.actions` on, an admin lets it propose to resume or cancel one of your own runs. Nothing happens until you press **Review the change** and then **Confirm the change**.

### 6. Rate the answer and keep your conversations

Press **Helpful** or **Not helpful** under an answer; for **Not helpful**, tick what was wrong and press **Save reasons**. **This solved my problem** closes the conversation. **New conversation** starts an empty one; **History** shows your earlier ones. Only you can read your conversations. An untouched conversation is deleted after 90 days.

You can also ask from the command line:

```bash
scf ask new "How do I connect a repository?"
scf ask show <id>
```

## Check that it worked

- The **Ask Foundry** button shows in the top bar of every page.
- A question gets an answer with a **How sure it is** line and its sources.
- `scf ask usage` shows the stage and the turns of the day (admins).

## Next steps

- [Turn ideas into stories with Ideas](/how-to/refine-ideas/)
- [Users and roles](/how-to/users-and-roles/)
- [Ask Foundry in the user guide](/guide/#14-ask-foundry)
- [Rolling out Ask Foundry](/guide/#rolling-out-ask-foundry)
