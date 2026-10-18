---
title: "How to write your own flow"
description: "Create a flow from a template, edit it visually or as YAML, reuse library blocks, let any AI write one, and check it with scf validate."
slug: write-a-flow
order: 1
group: "Configure and extend"
time: "PT30M"
---

This page is for admins who want the Foundry to work their way. A flow is a YAML pipeline of steps: agent steps, shell steps, approvals, parallel steps and sub-flows. When you are done, you have your own flow that you can run, give to a watcher or publish to users.

## Before you start

- The Foundry is installed and `scf ui` runs (see [Install](/how-to/install/)).
- You are signed in as an admin.
- You have a local git repository to try the flow on.

## Steps

### 1. Start from a template

`scf new` creates a small flow (implement, test, fix) that you can change:

```bash
cd ~/code/my-project
scf new my-flow
```

Add `--from <flow>` to start from another flow, or `--global` for a flow outside this repository. A flow in `<repo>/.claude-factory/flows/` is shared with your team through git. A flow in `~/.spaghetti-code-foundry/flows/` is just for you. Flows are looked up in that order, then the built-in ones.

### 2. Open it in the editor

Open **Flows** → **Flows** and pick your flow. Switch between the **visual** editor and **YAML** at the top. The header shows the scope, **Saved** or **Unsaved changes**, and whether the flow is **Valid**. The **Overview** button shows the graph of how the steps connect.

In the visual editor, select a row in the structure list to edit **Flow settings** or one step. Less used options are in groups such as **Routing**, **Limits** and **Sandbox & access**.

### 3. Add and connect steps

Use **Add step** for an Agent or Shell step, or **+ From library** to insert a ready-made block, for example a test loop, a code review or a secret scan. Each step decides where to go next with **On success**, **On failure** and **Routes**. A typical fix loop:

```yaml
steps:
  - id: implement
    type: claude
    prompt: "{{task}}"

  - id: run_tests
    type: shell
    run: npm test
    on_failure: fix_tests

  - id: fix_tests
    type: claude
    jump_only: true
    max_visits: 3
    prompt: |
      The tests fail. Fix the code.
      {{steps.run_tests.output}}
    on_success: run_tests
```

Shell commands may only template `{{vars.*}}`, `{{workdir}}` and `{{run.*}}`. Read the task and step outputs from environment variables such as `$FACTORY_TASK`. Tick **Needs repository access** (`repo_access: true`) on every shell step that calls `gh` or pushes.

### 4. Or let any AI write the flow

Print the flow guide and give it to any assistant, such as ChatGPT, Claude, Gemini, Codex or a local model:

```bash
scf flow-guide > flow-guide.md
```

Describe the flow you want, then save the YAML it answers with as `<repo>/.claude-factory/flows/<name>.yaml`. In the editor, **Draft flow with Claude** uses the same guide.

### 5. Check the flow

```bash
scf validate my-flow
```

It names the field and step for anything that is wrong. Paste that back to the assistant to fix it. In the editor, the **Problems** list does the same; click a row to go to the field.

### 6. Save and try it

Press **Save** (or Ctrl/Cmd+S), then **Test run**. From the terminal:

```bash
scf run my-flow --task "Add a --json flag to the export command" --var test_cmd="npm test"
```

### 7. Publish it to users (optional)

In **Flow settings**, open **Publish to users** and tick "Available to users". For each variable choose *hidden*, *fixed* or *user fills in*. A published flow cannot have sub-flow steps, and a shell step must read an input as `$FACTORY_VAR_NAME`.

## Check that it worked

- The editor header says **Valid** and **Saved**.
- `scf validate my-flow` reports no problems.
- `scf flows` lists your flow, and a test run shows its steps on the run page.

## Next steps

- [The complete flow format](/flow-format/)
- [Choose models and routing rules](/how-to/models-and-routing/)
- [Invite users and publish flows to them](/how-to/users-and-roles/)
- [Guide: Write your own flows](/guide/#4-write-your-own-flows)
