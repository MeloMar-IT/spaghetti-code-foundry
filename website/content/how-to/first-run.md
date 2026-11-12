---
title: "How to start your first change"
description: "Start a change with + New change or run a flow by hand on a local repository, then follow its five phases and check what it changed."
slug: first-run
order: 2
group: "Get started"
time: "PT15M"
---

This page is for you if you have installed the Foundry and want to see it work before you connect GitHub watchers. You start one change, follow it through its five phases and look at what it changed. The run works in its own copy of the code, so your checkout is not touched.

## Before you start

- The Foundry is installed, you are signed in and the Setup check is green (see [Install](/how-to/install/)).
- A repository the Foundry can work in: added under **My repositories** (or **Repositories** in the Admin view), or a local git repository on this Mac, for example `~/code/my-project`.
- You know the command that runs its tests, for example `npm test`. If not, the Foundry can detect it.

## Steps

### 1. Press + New change

![The Start work page, opened with + New change](../../docs/images/new-change.png)

**+ New change** in the top bar opens the **Start work** page. Type what you want in the box "What would you like to change?", for example "Add a --json flag to the export command". The line "In owner/name" shows the repository; **Change** picks another one.

### 2. Make a plan

Keep the starting point **A new idea** and press **Make a plan** (or Ctrl/⌘+Enter). The Foundry opens the page of your change request. It asks its questions first, then shows its plan. No flow is needed for this.

Other starting points: **An existing change** takes an issue number and opens a session on **Ideas**; **A conversation** lists your open sessions.

### 3. Or pick a flow yourself

Open **Advanced** on the same page to choose a flow. Pick the flow, pick the repository, and fill in the **Task** and the fields the flow asks for. **Review** shows everything that will be sent; **Start** starts the run and opens its page.

An admin can also run a flow from the editor: open **Flows**, choose a flow and press **Test run**. In the **Run** dialog, type the task, open **Advanced** for the repository and the variables, and press **▶ Start run**.

### 4. Or use the command line

```bash
cd ~/code/my-project
scf new my-flow
scf validate my-flow
scf run my-flow --task "Add a --json flag to the export command" --var test_cmd="npm test"
```

`scf new` creates a small flow that implements, tests and fixes. `scf validate` names the field and step for anything that is wrong. Leave `test_cmd` at `auto` to let the Foundry detect the test command.

The run happens in a fresh git worktree on a `factory/<run-id>` branch of your repository.

### 5. Follow the change

Open **Changes** in the sidebar and click the change. Its title is the task or the issue title. Under it is the phase strip: **Understand**, **Plan**, **Build**, **Check** and **Deliver**. The current phase is marked **Now**, with one sentence on what is happening. **What happens next** says who has the next move.

The page has three tabs. **Progress** shows the acceptance criteria and the task. **Details** holds **Steps**, a timeline of every step, and **Log**, the live log. An admin can open an agent step to read the whole conversation. The run ID and the flow are under **Technical details**.

### 6. Look at the result and decide

![What changed: the diff of a change, one file open](../../docs/images/run-diff.png)

Open the **What changed** tab. It shows the complete diff the run made. When the run finishes, its branch stays in your repository. Review it, merge it, or delete it.

If the run failed, the page shows a failure card with what happened, why and what you can do. **Retry from the failing step** continues the run at that step. In a terminal, `scf resume <run-id>` does the same.

## Check that it worked

- The change shows in **Changes** with its status, and all five phases are marked done when it succeeded.
- **Details** › **Steps** lists each finished step as passed or failed.
- **What changed** shows the diff, and your own checkout is unchanged.

## Next steps

- [Let the Foundry build your GitHub issues](/how-to/github-issues/)
- [Write your own flow](/how-to/write-a-flow/)
- [Resume a run that stopped](/how-to/resume-run/)
- [User guide: Run a flow](/guide/#2-run-a-flow)
