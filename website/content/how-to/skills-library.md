---
title: "How to add skills from an open-source library safely"
description: "Declare a skill source, import a reviewed commit into quarantine, scan, review and check it, then publish and approve a catalogue release."
slug: skills-library
order: 3
group: "Configure and extend"
time: "PT45M"
---

This page is for the admin who keeps the skill catalogue. An open-source skill library is never loaded straight into runs. You declare it in a reviewed file, import one exact commit into quarantine, check it offline, and only then publish a catalogue release that your installation approves.

## Before you start

- You are an admin with a terminal on the machine that runs the Foundry.
- You have a catalogue repository under git, where `skill-sources.yaml` lives and changes go in by pull request.
- You know the library's `https://` git address, the full commit id you want to use and its licence. Private sources are not supported.

## Steps

### 1. Declare the source in skill-sources.yaml

Add an entry under `sources:`. `ref.approved` must be a full commit id: a branch or tag can move, so it is only allowed in `ref.track`.

```yaml
schema: 1
sources:
  - id: example-skills
    repository: https://github.com/example/skills
    status: enabled
    ref:
      approved: 0123456789abcdef0123456789abcdef01234567
      track: main
    paths: [skills]
    adapter: agent-skills
    trust: community
    licence: { allow: [MIT, Apache-2.0] }
    update: { cadence: weekly }
    owner: "@octocat"
    review:
      by: "@octocat"
      on: 2026-10-13
      commit: 0123456789abcdef0123456789abcdef01234567
      licence: MIT
```

An enabled `trust: community` source needs a `review` whose `commit` equals `ref.approved`. A new commit needs a new review. Keep a source you have not reviewed yet at `status: disabled` with a `reason`.

### 2. Check the file

```bash
scf skills sources check
```

It works offline and ends with `OK <n> sources, <m> enabled`, or prints one `PROBLEM` line per error. `scf skills connectors` lists the reviewed connectors whose rules some repositories must follow. Open a pull request and let the owner and a reviewer approve it.

### 3. Import the approved commit into quarantine

```bash
scf skills import example-skills
```

It fetches only `ref.approved` over https and stages the skills in `<data folder>/skill-quarantine/`, with the licence and notice files. Nothing is loaded or run. Rejected skills (a symbolic link, a submodule, too large) print a `REJECTED` line.

### 4. Scan the import

```bash
scf skills scan example-skills
```

The report is offline and read-only. A high finding that is not accepted blocks its skill; a secret finding can never be accepted. Skills that need network access, live integrations or MCP configuration are `EXCLUDED`. Findings you have reviewed go into `skill-scan-exceptions.yaml` by pull request, each with a reason, an owner and an expiry date.

### 5. Review the import

```bash
scf skills review example-skills --markdown > review.md
```

One report per import: licence verdict, attribution files, scan result and collisions with the skills you already have, grouped by category. Use the Markdown for a pull-request body. Nothing is promoted.

### 6. Check the promotion

```bash
scf skills promote check example-skills
```

Each path prints `PROMOTABLE` or `REFUSED` with the reason, such as a missing or ambiguous licence or an open high finding. For a source that needs a licence review, read the lines, then set `licence.reviewed` to the printed digest by pull request.

### 7. Publish a catalogue release

List the release in `skill-releases.yaml` with a `review`, commit both files, then:

```bash
scf skills releases check
scf skills release publish scf-skills@0.1.0
```

Publishing refuses and writes nothing when a skill is not promotable, its evaluation does not pass, or the files are not committed. On success it prints an `APPROVE` line.

### 8. Approve the release

Copy the `APPROVE` line into `skills.releases.approved` (catalogue, version and digest). You can do this on the Skills card of **Administration** → **Settings**, under **Approved releases**. Before you approve a newer release, see what it changes:

```bash
scf skills release diff scf-skills@0.1.0 scf-skills@0.2.0
```

## Check that it worked

- `scf skills release list` shows the release as approved.
- `scf skills` lists its packages and exits 0 when there are no problems.

## Next steps

- [Keep your code and secrets safe](/how-to/safety/)
- [Guide: Skill library sources](/guide/#skill-library-sources)
- [Guide: Publish a catalogue release](/guide/#publish-a-catalogue-release)
- [Guide: Scan an import](/guide/#scan-an-import)
