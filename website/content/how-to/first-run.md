---
title: "How to run your first flow by hand"
description: "Create a small flow, run it on a local git repository in its own worktree, then check the steps and the diff in the web UI."
slug: first-run
order: 2
group: "Get started"
time: "PT15M"
---

This page is for you if you have installed the Foundry and want to see it work before you connect GitHub. You run one flow by hand on a local repository. The run works in its own copy of the code, so your checkout is not touched.

## Before you start

- The Foundry is installed and the `scf` command works (see [Install](/how-to/install/)).
- Claude Code (`claude`) is installed and logged in on this Mac.
- A local git repository to try it on, for example `~/code/my-project`.
- You know the command that runs its tests, for example `npm test`. If not, the Foundry can detect it.

## Steps

### 1. Go to your repository

```bash
cd ~/code/my-project
```

### 2. Create a small flow from the template

```bash
scf new my-flow
```

This creates a small flow that implements, tests and fixes. You can check a flow at any time:

```bash
scf validate my-flow
```

It names the field and step for anything that is wrong.

### 3. Start the run

Describe the task in plain language and name the test command:

```bash
scf run my-flow --task "Add a --json flag to the export command" --var test_cmd="npm test"
```

The task is what you want done; flows use it in their prompts. Variables are settings the flow exposes, such as `test_cmd`. Leave it at `auto` to let the Foundry detect the test command (npm, pnpm, yarn, pytest, Go, Cargo, Gradle, Maven, Make).

The run happens in a fresh git worktree on a `factory/<run-id>` branch of your repository. Your checkout is not touched.

### 4. Or start it from the web UI

If you prefer the UI, start it with `scf ui`, open **Flows**, pick the flow on the left and press **▶ Run**. Fill in the **Task**, the **Repository** and the **Variables**, and start it.

### 5. Follow the run

Start the UI if it is not running yet:

```bash
scf ui
```

Open **Runs** and then the run. At the top, **What happens next** says who has the next move. The **Steps** tab is a timeline of every step, and the live log shows each step as it starts and ends. An admin can open an agent step to read the whole conversation.

### 6. Look at the result and decide

Open the **Changes** tab. It shows the complete diff the run made. When the run finishes, its branch stays in your repository. Review it, merge it, or delete it.

If the run failed, the page shows a failure card with what happened, why, and what you can do. **Retry from the failing step** continues the run at that step. From the terminal you can do the same:

```bash
scf resume <run-id>
```

## Check that it worked

- The run shows in **Runs** with its status, and the **Steps** tab lists each finished step as passed or failed.
- **Changes** shows the diff of the run.
- Your repository has a new `factory/<run-id>` branch, and your own checkout is unchanged.

## Next steps

- [Let the Foundry build your GitHub issues](/how-to/github-issues/)
- [Write your own flow](/how-to/write-a-flow/)
- [Resume a run that stopped](/how-to/resume-run/)
- [User guide: Run a flow](/guide/#2-run-a-flow)
