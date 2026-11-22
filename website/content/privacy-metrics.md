---
title: "Privacy: shared metrics"
lead: "Sharing metrics is optional. This page says what is shared, what never is, how to see it first, how to stop, and how the data is removed."
description: "Optional metrics sharing in Spaghetti Code Foundry: numbers only, once a day, what is never shared, how to preview and stop, and how the data is removed."
---

## Why

The Foundry can share numbers about its runs, so the people who build it can see how it is used. Sharing is optional
and nothing is sent until someone says yes.

## Who is asked

Each person account is asked once, on Today, whether the metrics of its runs may be shared. Service accounts are never
asked and never count.

## What is shared

Numbers only, once a day, after the UTC day has ended. A report covers:

- runs and their outcomes: how many started, finished and failed, and how long they took;
- tokens and cost;
- splits and rework;
- quality outcomes: first-pass tests, merge rate and evidence;
- policy blocks, denials and questions answered automatically;
- watcher sources and flow use, with built-in flow, step and model names;
- the number of repositories, as a count only;
- the Foundry version, the day and a random install id.

## What is never shared

Your code, tasks, step output, the text of a change, names, e-mail addresses, repository and branch names, paths and
IP addresses.

## See it first

- In the web interface, **What is shared** on Today and in Account settings shows the report for your own runs. An
  admin sees the report of the whole install. Nothing is sent by it.
- On the computer that runs the Foundry, `scf metrics preview` prints the report of one day exactly as it would be
  shared. It sends nothing.

## Change your answer

Open the account menu, then Account settings. Saying no stops that account's numbers from future reports. Reports sent
before that stay until they are removed (see below).

## The admin switch

An admin can switch sharing off for the whole install in Settings, under Metrics sharing. Then nobody is asked, nothing
is sent, and the answers given are kept for when it is switched on again.

## How the data is removed

Sharing stays on while any account says yes. The delete is sent when the last sharing account says no, or when an
admin switches sharing off. Then the install takes a new id and keeps the old id and its receiver address in
`metrics-share.json` until the delete is acknowledged. A failed delete is retried, and dropped after 7 days.

Reports carry no name and no IP address, and they are removed after 400 days. The web server in front of the receiver
is set not to log requests; this is a deployment setting.

There is no contact address for removal. There are two ways to remove data:

- **In the app:** stop sharing, as above. The delete is sent for you.
- **By hand:** someone who still has the data folder can send `DELETE <receiver>/api/metrics/<id>`. The default
  receiver is `https://spaghetti-code-foundry.com`. While sharing is on, the id is the `install` in `metrics-share.json`.
  After a switch-off, use the `install` of an entry in `deletes`, with the `endpoint` of that entry. A manual delete
  does not stop later pushes, so switch sharing off as well.

## What is public

The receiver publishes totals at `https://spaghetti-code-foundry.com/metrics.json`: per day for the last 35 days, and
per week. Every shared number is shown, also when only one install gave it, so while few installs share, a total
can be the numbers of a single install.
