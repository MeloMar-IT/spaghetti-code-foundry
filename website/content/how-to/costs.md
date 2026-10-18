---
title: "How to control costs and read the dashboard"
description: "Set a daily budget, run and step limits and per-user limits, read spend on the dashboard, and compare models on your own code with evals."
slug: costs
order: 5
group: "Configure and extend"
time: "PT20M"
---

This page is for admins who pay for the models or share them with a team. You set limits on how much the Foundry may spend, see where the money goes, and use evals to find the cheapest model that still does the job.

## Before you start

- You are signed in as an admin.
- You know how your agents are logged in: a Claude subscription, an API key, a ChatGPT login or a local model.

## Steps

### 1. Know what the amounts mean

The costs shown are estimates at API prices, as reported by Claude Code. Whether you pay them depends on the login:

- Claude Code with a Claude subscription (Pro/Max): no per-token charges; usage counts toward your plan's limits.
- Claude Code with an API key (`ANTHROPIC_API_KEY`): billed per token, so the amounts are real.
- Codex with your ChatGPT login: recorded as $0 with the token count.
- Local models: free, recorded as $0.

Budgets use these amounts either way, so they also protect your subscription limits.

### 2. Set the daily budget

Open **Administration** → **Settings** → **Budget & capacity**. The daily budget stops new work when today's estimated spend reaches it. Paused runs continue the next day, or when you raise the budget and resume them.

On a fixed-price subscription you can turn off **Enforce cost limits** (`cost_limits: false`). Costs are still recorded, but nothing is stopped because of money. The usage limits that Claude and Codex report themselves still pause runs.

### 3. Cap runs and steps in a flow

```yaml
limits:
  max_cost_usd: 20      # the whole run stops at this cost
defaults:
  max_budget_usd: 5     # per agent step
```

A run that reaches its budget fails with a message that says so. A change to the flow counts only for a new run; a resumed run keeps the flow it started with.

### 4. Set limits per user

On **Administration** → **Users**, **Default limits** sets three limits for every account: runs at the same time, runs per day and the daily budget in USD. Open an account and use **Limits** to give it its own values. An empty field means "no limit". A job over a limit waits in the queue and starts by itself when the limit allows.

### 5. Read the dashboard

Open **Administration** → **Dashboard**. It shows spend today and over 30 days, the success rate, **Needs a human**, the **Waiting** card, cost per day, the **By user** card, results per flow and per repository, the steps where runs fail most, and eval results. An account at a limit gets an **at limit** mark. For a quick look, **Administration** → **Overview** has a **Limits** card with today's spending and the accounts at a limit.

### 6. Compare models with an eval

An eval suite runs sample tasks through flows and models and scores them:

```yaml
# evals/my-suite.yaml
name: my-suite
flows: [quick]
cases:
  - name: add-multiply
    repo: fixtures/calc
    task: Add a multiply(a, b) function to calc.js.
    vars: {test_cmd: node --test}
    check: node --test
```

```bash
scf eval evals/my-suite.yaml --models sonnet,codex,ollama:qwen3-coder
```

The report shows pass rate, average cost, tokens, time and fix loops per variant, and appears on the Dashboard. If a cheaper model passes as often, route more steps to it.

## Check that it worked

- The Dashboard shows today's spend below your daily budget.
- The **By user** card shows each account's limits next to its numbers, for example `2 / 5`.
- Your eval report appears with the eval results on the Dashboard.

## Next steps

- [Choose models and routing rules](/how-to/models-and-routing/)
- [Invite users and set roles](/how-to/users-and-roles/)
- [Guide: Costs, dashboard and evals](/guide/#8-costs-dashboard-and-evals)
- [Guide: Dashboard](/guide/#dashboard)
