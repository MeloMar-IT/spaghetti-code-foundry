---
title: "How to invite users and set roles"
description: "Add accounts, send set-password links, choose admin or user, publish flows for users and let them run work on their own repositories."
slug: users-and-roles
order: 6
group: "Configure and extend"
time: "PT15M"
---

This page is for admins who want to share one Foundry with a team. An admin makes flows, watchers and settings. A user runs the flows the admin published, on their own repositories, and sees only their own runs. When you are done, a new user can sign in and start work.

## Before you start

- You are signed in as an admin.
- You have at least one flow you want users to run (see [Write your own flow](/how-to/write-a-flow/)).
- If people sign in from other computers, the UI is reachable for them (see the guide's section on access from other computers).

## Steps

### 1. Add the account

Open **Administration** → **Users** and press **Add user**. Enter name, e-mail and role. The dialog then shows a set-password link once. The link works once, for 24 hours. Send it to the person yourself. If you closed the dialog too early, open the account and use **New link**.

From the terminal you can do the same with a password you type:

```bash
scf user create --name "Sam Doe" --email sam@example.com
scf user list
```

### 2. Choose the role

There are two roles:

- **admin**: may make every call and sees every page.
- **user**: works on a smaller display at `/user/` with **Start work**, their own runs, **My repositories** and **Refinement**. A user never sees costs, models, step output, settings or other accounts' runs.

Change a role on the account page with **Edit**, or:

```bash
scf user role sam@example.com user
```

The last admin that is not blocked cannot be demoted, blocked or deleted. Make another admin first.

### 3. Publish flows for users

Built-in flows are not published, and after an upgrade users see no flows until you publish some. In **Flows** → **Flows**, open a flow (save a copy of a built-in one first), go to **Flow settings** → **Publish to users** and tick "Available to users". For each variable choose:

- *hidden*: your value is used;
- *fixed*: shown, cannot be changed;
- *user fills in*: with a label, help text, "Required" and a default.

For users' repositories, use `workspace: empty` and clone in a `repo_access` step. Flows with `worktree` or `inplace` are refused for users. Never put user input into a shell command; read `"$FACTORY_VAR_NAME"` instead.

### 4. Let the user connect their repositories

The user opens **Repositories** → **My repositories** and presses **Add repository**. They give the address and a sign-in method: a GitHub fine-grained token (Contents, Issues and Pull requests, each "Read and write"), an HTTPS token, an SSH deploy key, or the GitHub App when you have set it up. The Foundry tests the connection right away. A user can only run flows on their own repositories.

### 5. Set limits

On the account page, **Limits** sets runs at the same time, runs per day and a daily budget in USD. **Default limits** applies to every account. A user who reaches a limit sees "waiting — your limit for today is reached".

### 6. Check what the user sees

On the account page, press **View as user**. You see that user's display read-only for 30 minutes. Press **Back to the admin display** to return.

## Check that it worked

- The Users page shows the account as **active** after the person has set a password.
- In **View as user**, **Start work** lists your published flows.
- A run the user starts shows in **Runs** with them as owner.

## Next steps

- [Connect a repository](/how-to/connect-repository/)
- [Control costs and read the dashboard](/how-to/costs/)
- [Guide: Roles and permissions](/guide/#roles-and-permissions)
- [Guide: Access from other computers](/guide/#access-from-other-computers)
