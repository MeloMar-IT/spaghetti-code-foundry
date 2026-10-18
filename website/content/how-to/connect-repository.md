---
title: "How to add a repository and choose its sign-in"
description: "Add a repository under My repositories, pick a token, deploy key or GitHub App for the Foundry to sign in with, and test the connection."
slug: connect-repository
order: 4
group: "Get started"
time: "PT10M"
---

This page is for every account, admin or user, that wants the Foundry to work on a repository. You add the repository once and choose how the Foundry signs in to it. Runs you own then use that sign-in, and nothing else.

## Before you start

- You are signed in to the Foundry's web UI.
- You know the address of the repository: `https://github.com/owner/repo`, or an SSH address such as `git@github.com:owner/repo.git`.
- You have decided on a sign-in method (see step 2). For a GitHub token, create a fine-grained personal access token with these repository permissions, each "Read and write": **Contents**, **Issues** and **Pull requests**.
- For the GitHub App: an admin has set up the app under **Settings** → **GitHub App**.

## Steps

### 1. Open My repositories

Go to **Repositories** → **My repositories** and press **Add repository**. Step 1 of the dialog asks for the address. Type it and press **Next**.

### 2. Choose how the Foundry signs in

Steps 2 and 3 ask for the method and its details. The methods are:

- **GitHub token:** a fine-grained personal access token. `gh` and git use it. A token made for reading only fails at the first push or comment.
- **HTTPS token:** a user name and a token, for git hosts other than GitHub.
- **SSH deploy key:** you type the SSH address and no secret. The Foundry makes a key pair and shows the public key. A deploy key gives git access only, so it cannot work with issues or pull requests.
- **GitHub App:** no token needed. It is offered only for a GitHub repository with an https address, and only when the admin has set up the app.
- **The server's own access:** only an admin can choose it. Runs then use the Mac's own `gh` login and git settings.

The built-in issue flows call `gh`, and a watcher needs the server's own access, a GitHub token or the GitHub App. Choose one of these if you want the Foundry to build your GitHub issues.

### 3. Enter the details and save

- For a token, type it in the password field. It is never shown again.
- For the GitHub App, press **Install the app on GitHub**, choose "Only select repositories" and pick this repository.
- For a deploy key, open the repository after saving and copy the public key with **Copy**. On GitHub, add it under **Settings** → **Deploy keys** → **Add deploy key**, with "Allow write access".

Press **Add repository** to save. **Back** returns to the address and keeps what you typed.

### 4. Read the connection test

The Foundry tests the connection by itself right after you save. The dialog shows the address, the method, the result of each check and "A token is stored. It is never shown again." There are up to three checks:

- **Read:** a shallow clone.
- **Write:** a `git push --dry-run` to a scratch branch name. Nothing is pushed.
- **GitHub API:** the repository, its issues and its pull requests can be read. This check is skipped for a deploy key.

If the test fails, the repository is kept. Press **Test again**, or **Change details** to enter new details. Press **Done** to close.

### 5. Change the sign-in later

Press **Open** on the row to see the repository page. Its **Connection** section has **Test connection** and **Change authentication**. When you change the method, a last step says what will be replaced; tick "Replace the current sign-in" and press **Replace the sign-in**. **Remove**, under **Dangerous actions**, also deletes the stored token or key.

## Check that it worked

- The row on **My repositories** shows how the Foundry signs in and the status **Connected**.
- The repository page shows **Provider**, **Identity** and **Scope**, with Read, Write and GitHub API each marked "works", "failed" or "not checked".
- On **Start work**, the repository is offered with the status "Connected".

## Next steps

- [Let the Foundry build your GitHub issues](/how-to/github-issues/)
- [Keep runs safe](/how-to/safety/)
- [Manage users and roles](/how-to/users-and-roles/)
- [User guide: Roles and permissions](/guide/#roles-and-permissions)
