---
title: "How to turn an idea into ready stories"
description: "Use a session on Ideas and the architect to grow a rough idea or an existing issue into stories that meet the Definition of Ready."
slug: refine-ideas
order: 4
group: "Daily work"
time: "PT30M"
---

This page is for anyone who writes stories for the Foundry. A story that is clear before it is built is built right the first time. On **Ideas** the architect reads the code and the open issues, asks questions and proposes text. You stay in charge: you write the story, you decide, and you press **Publish**.

## Before you start

- The repository is in **My repositories**, with a sign-in that can read Contents and Issues (a token or the GitHub App; a deploy key cannot read the issue list).
- You have an idea in your own words, or the number of an open issue.
- The architect's reads cost money: a context brief or a question round costs at most $3, a suggestion or a review at most $1.

## Steps

### 1. Start a session

![The Ideas page with the list of sessions and the New session button](../../docs/images/ideas.png)

Open **Ideas** in the sidebar and press **New session**. Choose the kind:

- **An idea**: choose a repository and write the idea (up to 10,000 characters). A title is optional.
- **An existing GitHub issue**: choose a repository and give the issue number, for example `12` or `#12`. If the issue has the build label, the page warns you and offers **Remove the build label**.

Press **Start session**. Nothing is written to GitHub. You can also start from **+ New change**: **An existing change** takes an issue number and opens a session, and **A conversation** lists your open sessions. To find issues that are not ready yet, use **Backlog readiness** and press **Refine** on a row.

![A session page with the row of parts: Idea and brief, Conversation, Story drafts, Hand off and Log](../../docs/images/refinement-session.png)

The session page has a row of five parts: **Idea and brief**, **Conversation**, **Story drafts**, **Hand off** and **Log**. One part is shown at a time. A line "Next:" names the next step; it is advice only.

### 2. Ask the architect to look at the code

In **Idea and brief**, press **Ask the architect to look at the code**. The architect only reads. It writes a **context brief** in five parts: *What already exists*, *Code the idea would touch*, *Open issues that overlap*, *Rules that apply* and *Could not find out*. Every claim names its file or issue.

### 3. Answer the architect's questions

In **Conversation**, press **Ask the architect for questions**. Each question has a point of view (need, build or test), why it matters, and 2 to 4 options; the recommended one is marked. For each question press **Choose**, type your own answer and press **Send my answer**, or press **I don't know yet**. Then **Ask for another round**. In **Map**, press **Accept** or **Reject** on each proposed rule or example.

### 4. Write the story drafts

In **Story drafts**, press **New draft**. Fill in the title, "As …", "I want …", "so that …", the acceptance criteria, out of scope, depends on and notes for the builder. Text is saved by itself. **Suggest** next to a field asks the architect for a proposal; **Accept**, **Edit and accept** or **Reject** it. **Review draft** asks the architect to point out weak spots. **Preview** shows the story as it will look on GitHub.

### 5. Check the Definition of Ready

Each open draft has a part **Definition of Ready**. Press **Check readiness**. Each item shows **Met**, **Not met**, **Unsure** or **Not checked yet**, with a reason. A story with an open question or an implementation plan is not ready. You may use **Accept anyway** on another item, with a reason. When every item is met or accepted, the draft shows **Ready**.

### 6. Split a story that is too big

A draft with at least 2 acceptance criteria has **Split**. The architect proposes up to 3 ways. Press **Use this way**, change the plan if you like, and press **Confirm split**. Each part becomes its own draft with **Depends on** set; the original stays as a read-only record.

### 7. Publish

In **Hand off**, press **Publish**. A window lists the issues in the order they will be created. Tick labels per draft. Tick **Start building this story** if the Foundry should build it at once (it adds the build label). Nothing is sent until you press **Create the issues**.

## Check that it worked

- Each published draft shows **On GitHub: #n** with a link, and its fields are read only.
- The session shows *Published* when every draft is on GitHub.
- On GitHub, a draft that depends on another names the real issue number under **Depends on**.

## Next steps

- [Hand the Foundry a whole epic](/how-to/split-epic/)
- [Ask Foundry for help in the app](/how-to/ask-scf/)
- [Ideas in the user guide](/guide/#12-ideas-refinement)
- [Ideas in short](/guide/#ideas-in-short)
