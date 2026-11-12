---
title: "How to choose models and routing rules"
description: "Pick Claude Code, Codex or a local model per step, set routing rules and a default model, and add fallbacks for when a model hits a limit."
slug: models-and-routing
order: 2
group: "Configure and extend"
time: "PT15M"
---

This page is for admins who want to decide which model does which work. Steps run on Claude Code or Codex, on Anthropic, OpenAI or local models (Ollama, LM Studio). When you are done, routing rules pick the model per step, and fallbacks keep runs going when a model hits a rate or usage limit.

## Before you start

- You are signed in as an admin, in the Admin view.
- Claude Code (`claude`) is installed and signed in. The **Setup check** (`#/setup`, or type "Setup" in **Search**) tells you what is missing.
- Optional: the Codex CLI, for Codex steps. The shipped flows use it for reviews.
- Optional: Ollama or LM Studio, for local models.

## Steps

### 1. Check the coding agents

Open **Administration** in the sidebar, then **Models** under **Operations**. The **Coding agents** panel shows whether Claude Code and Codex are installed and logged in. To add Codex:

```bash
npm i -g @openai/codex
codex login
```

Codex uses your ChatGPT login. Claude Code uses your Claude login or an API key.

![The Models page: coding agents, providers and routing rules](../../docs/images/models.png)

If you prefer plain questions, the **Claude and Codex** page (**Help** → **Set up Claude and Codex**) asks which tools and plans you have and how they should share the work. Its answers set the default model, the fallback and the routing rules. Settings you set by hand are kept unless you confirm that they may be replaced.

### 2. Learn the model specs

Wherever you pick a model (a step, a flow's defaults, a routing rule, an eval), you write a model spec:

| Spec | Runs on |
|---|---|
| `sonnet`, `opus`, `haiku` | Claude Code, Anthropic |
| `codex` | Codex, its default OpenAI model |
| `codex:gpt-5` | Codex with a specific model |
| `ollama:qwen3-coder:30b` | Claude Code on a local Ollama model |
| `codex:ollama:gpt-oss:20b` | Codex on a local Ollama model |
| `lmstudio:<model>` | Claude Code on LM Studio |

### 3. Add a provider and try a model

Anthropic, OpenAI, Ollama (`localhost:11434`) and LM Studio (`localhost:1234`) are built in. To use another Ollama host or any Anthropic-compatible API, use **Add a provider**. Each provider is a link to its own page, with its settings, **Save provider** and a **Try a model** box. Use **Try a model** to check that a model works before you rely on it.

Local models cost nothing and keep your code on your machine. Choose models trained for coding and tool use, such as `qwen3-coder` or `gpt-oss`. General chat models often fail to call tools.

### 4. Set routing rules

Rules decide which model runs which step. The first matching rule wins, even over models written in flows and blocks. A rule matches on a step id pattern, a flow name pattern and/or a visit number (`From visit 2` means only retries). The **Agent** column narrows a rule to *Claude Code steps* or *Codex steps*; the default is *any agent*. The presets add common rules:

- **Retries on Opus**: fix steps use Opus from their second attempt.
- **Codex reviews Claude's code**: review steps run on Codex.
- **Small jobs on a local model**: triage and learning steps run locally. It is offered only when a local model is set up.

### 5. Set the default model

Without a matching rule, a step uses its own model, then the flow's default, then the **Default model**. In a flow, set the default for all agent steps:

```yaml
defaults:
  model: claude-sonnet-5-5
  agent: claude
```

A single step can override it with `model:`, `agent:` or `provider:`.

### 6. Add fallback models

**Fallback models** are tried in order when a model hits a rate or usage limit. With **Continue on the first free one (local / ChatGPT) when a budget runs out, instead of pausing** ticked, runs switch to the first free fallback instead of pausing when the daily or run budget is used up.

## Check that it worked

- The **Coding agents** panel shows each agent as installed and logged in.
- **Try a model** gives a result for the models you use.
- On a change's page, open **Details** → **Steps**: each step shows which agent and model ran it. Check that it matches your rules.

## Next steps

- [Control costs and read the dashboard](/how-to/costs/)
- [Write your own flow](/how-to/write-a-flow/)
- [Guide: Models, agents and routing](/guide/#5-models-agents-and-routing)
- [Guide: Providers and local models](/guide/#providers-and-local-models)
