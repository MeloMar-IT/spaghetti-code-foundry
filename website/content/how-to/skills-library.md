---
title: "How to add skills from an open-source library safely"
description: "Declare a skill source, import a reviewed commit into quarantine, scan it, measure its effect, then publish and approve a catalogue release."
slug: skills-library
order: 3
group: "Configure and extend"
time: "PT45M"
---

This page is for the admin who keeps the skill catalogue. An open-source skill library is never loaded straight into runs. You declare it in a reviewed file, import one exact commit into quarantine, check it offline, measure whether each skill helps, and only then publish a catalogue release that your installation approves.

## Before you start

- You are an admin with a terminal on the machine that runs the Foundry.
- You have a catalogue repository under git, where `skill-sources.yaml` lives and changes go in by pull request.
- You know the library's `https://` git address, the full commit id you want to use and its licence. A private source is possible only for your own repository (`trust: first-party`), registered under **My repositories** with the GitHub App.

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

It fetches only `ref.approved` and stages the skills in `<data folder>/skill-quarantine/`, with the licence and notice files. Nothing is loaded or run. Rejected skills (a symbolic link, a submodule, too large) print a `REJECTED` line.

### 4. Scan and review the import

```bash
scf skills scan example-skills
scf skills review example-skills --markdown > review.md
```

The scan is offline and read-only. A high finding that is not accepted blocks its skill; a secret finding can never be accepted. Findings you have reviewed go into `skill-scan-exceptions.yaml` by pull request, each with a reason, an owner and an expiry date. The review is one report per import: licence verdict, attribution files, scan result and collisions with the skills you already have. Use the Markdown for a pull-request body.

### 5. Measure whether a skill helps

```bash
scf skills effect example-skills example-skill
```

It runs the skill's sample tasks twice in the macOS sandbox, once with the skill and once without, and stores the verdict: `helps`, `no-measurable-effect` or `harms`. `harms` always blocks promotion; `no-measurable-effect` needs an owner decision. The `effect` column of `scf skills` shows the newest verdict. Each run costs agent sessions, so check the number of scenarios first.

### 6. Check the promotion

```bash
scf skills promote check example-skills
```

Each path prints `PROMOTABLE` or `REFUSED` with the reason, such as a missing licence, an open high finding, a failed evaluation or a harmful effect. For a source that needs a licence review, read the lines, then set `licence.reviewed` to the printed digest by pull request.

### 7. Publish a catalogue release

List the release in `skill-releases.yaml` with a `review`, commit both files, then:

```bash
scf skills releases check
scf skills release publish scf-skills@0.1.0
```

Publishing refuses and writes nothing when a skill is not promotable, its evaluation does not pass, or the files are not committed. On success it prints an `APPROVE` line.

### 8. Approve the release

Copy the `APPROVE` line into `skills.releases.approved` (catalogue, version and digest). You can do this on the **Skills** card of **Administration** → **Settings**, under **Approved releases**. Before you approve a newer release, see what it changes:

```bash
scf skills release diff scf-skills@0.1.0 scf-skills@0.2.0
```

### 9. Let your own library update itself (optional)

A first-party source can have `update: { cadence: weekly, auto: true }`. A due update then stages the new commit, runs the licence, scan and profile gates and the catalogue's evaluation suite, and publishes and approves a release without a pull request. A skill that fails a gate is left out, and gets one issue in the source's own repository, titled `Skill <id> failed the <gate> gate`. The issue has the label of the `skill-write` flow, so the Foundry can fix the skill: it writes and checks the skill, measures its effect with and without it, and only then publishes it to the library.

## Check that it worked

- `scf skills release list` shows the release as approved.
- `scf skills` lists its packages, with their effect, and exits 0 when there are no problems.

## Next steps

- [Keep your code and secrets safe](/how-to/safety/)
- [Guide: Skill library sources](/guide/#skill-library-sources)
- [Guide: Measure the effect of a skill](/guide/#measure-the-effect-of-a-skill)
- [Guide: Publish a catalogue release](/guide/#publish-a-catalogue-release)
