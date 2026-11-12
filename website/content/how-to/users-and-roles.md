---
title: "How to invite users and set roles and views"
description: "Add accounts, choose admin or user and the Simple, Advanced or Admin view, publish flows for users, and sign in through your own identity provider."
slug: users-and-roles
order: 6
group: "Configure and extend"
time: "PT15M"
---

This page is for admins who want to share one Foundry with a team. An admin makes flows, watchers and settings. A user runs the flows the admin published, on their own repositories, and sees only their own changes. When you are done, a new user can sign in and start work.

## Before you start

- You are signed in as an admin, in the Admin view.
- You have at least one flow you want users to run (see [Write your own flow](/how-to/write-a-flow/)).
- If people sign in from other computers, the UI is reachable for them (see the guide's section on access from other computers).

## Steps

### 1. Add the account

Open **Administration** in the sidebar, then **Users** under **People and access**, and press **+ Add user**. Enter name, e-mail and role. For someone who is not an engineer, tick **Simple account**: it sets the role to user and the Simple view, and the guide opens at their first sign-in. The dialog then shows a set-password link once. The link works once, for 24 hours. Send it to the person yourself. If you closed the dialog too early, open the account and use **New link**.

![The Users page under Administration, People and access](../../docs/images/users.png)

From the terminal you can do the same with a password you type:

```bash
scf user create --name "Sam Doe" --email sam@example.com
scf user list
```

### 2. Choose the role

There are two roles:

- **admin**: may make every call and sees every page.
- **user**: works on the user display at `/user/`, with **Today**, **Changes**, **Ideas**, **Releases**, **Help** and **+ New change**. A user never sees costs, models, step output, settings or other accounts' changes.

Press a name on the Users page to open the account page. Change a role there with **Edit**, or:

```bash
scf user role sam@example.com user
```

The last admin that is not blocked cannot be demoted, blocked or deleted. Make another admin first.

### 3. Know the three views

Each person picks a view with **View** in their account menu: **Simple** (plain words, one page per project, no logs or costs), **Advanced** (the user display, with **My repositories**) or **Admin** (the admin display, with **Board**, **Repositories**, **Flows** and **Administration**). A user chooses Simple or Advanced; an admin may choose all three. The view changes only what the display shows. The server still checks every call by the role.

### 4. Publish flows for users

Built-in flows are not published, and after an upgrade users see no flows until you publish some. Choose **Flows** in the sidebar, open a flow (save a copy of a built-in one first), select **Flow settings** and open **Publish to users**. Tick "Available to users". For each variable choose:

- *hidden*: your value is used;
- *fixed*: shown, cannot be changed;
- *user fills in*: with a label, help text, "Required" and a default.

For users' repositories, use `workspace: empty` and clone in a `repo_access` step. Flows with `worktree` or `inplace` are refused for users. Never put user input into a shell command; read `"$FACTORY_VAR_NAME"` instead.

### 5. Let the user connect their repositories

The user opens **My repositories** in the sidebar (Advanced view) and presses **Add repository**. They give the address and a sign-in method: a GitHub fine-grained token (Contents, Issues and Pull requests, each "Read and write"), an HTTPS token, an SSH deploy key, or the GitHub App when you have set it up. The Foundry tests the connection right away. **Administration** → **Credentials** lists the stored credentials of all accounts, without any secret.

### 6. Set limits and workspaces

On the account page, **Limits** sets runs at the same time, runs per day and a daily budget in USD. **Default limits** on the Users page applies to every account. A user who reaches a limit sees "waiting — your limit for today is reached". When teams share the Foundry, list them as workspaces in `config.yaml`: a user then sees only the repositories, changes and sessions of their own workspaces.

### 7. Sign in through your own account system (optional)

A plugin that calls `api.identityProvider` makes your own account system the source of sign-in, role and workspace. People are signed in on their next visit and need no password here. The Foundry keeps a mirror of each account; on the Users page its status is **account system**, and it has no **Edit**, **New link** or **Reset password**. The Foundry's own password sign-in is switched off. Mark one active admin with a password as the emergency local admin, for when the account system is down:

```bash
scf user break-glass admin@example.com on
```

Each emergency sign-in is written to the audit log. Keep that password safe.

### 8. Check what the user sees

On the account page, press **View as user** under **Actions**. You see that user's display read-only for 30 minutes. Press **Back to the admin display** to return.

## Check that it worked

- The Users page shows the account as **active** after the person has set a password.
- In **View as user**, **+ New change** lists your published flows under **Advanced**.
- A change the user starts shows in **Changes** with them as owner.

## Next steps

- [Connect a repository](/how-to/connect-repository/)
- [Control costs and read the dashboard](/how-to/costs/)
- [Guide: Simple, Advanced and Admin view](/guide/#simple-advanced-and-admin-view)
- [Guide: Roles and permissions](/guide/#roles-and-permissions)
