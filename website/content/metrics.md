---
title: "Metrics"
lead: "How the Foundry does in real use, in numbers from installs that choose to share them."
description: "Live numbers from Spaghetti Code Foundry installs that share metrics: speed, rework, quality, cost and use, with the definition of every number."
measures:
  runsStarted:
    label: "Runs started"
    definition: "The number of runs that started in the period."
  runsEnded:
    label: "Runs ended"
    definition: "The runs that ended in the period, by how they ended: succeeded, failed or cancelled."
  workItemsDelivered:
    label: "Work items delivered"
    definition: "The number of work items (issues, pull requests or CI runs) that a run delivered. Counted once for each day."
  pullRequestsDelivered:
    label: "Pull requests delivered"
    definition: "The number of pull requests that runs opened or updated."
  runDuration:
    label: "Run time"
    definition: "The time from the start of a run to its end. Shown as the median (half of the runs are faster) and the 90th percentile (nine in ten runs are faster)."
  stepTime:
    label: "Time per built-in step"
    definition: "The median time of each step of the built-in flows. Steps of your own flows are counted as custom."
  issuesSplit:
    label: "Stories split"
    definition: "The number of stories that were too big and were split into parts."
  partsPerSplit:
    label: "Parts per split"
    definition: "The number of parts a split story became. Shown as the median and the 90th percentile."
  stepRetries:
    label: "Step retries"
    definition: "The number of times a step was tried again after it failed."
  repeatedSteps:
    label: "Repeated steps"
    definition: "How often a step ran again in the same run, such as test fixes and review rounds. Built-in steps only."
  stoppedWithQuestions:
    label: "Questions for a person"
    definition: "The number of runs that stopped to ask a person a question."
  questionsAnsweredAutomatically:
    label: "Questions answered automatically"
    definition: "The number of questions that the Foundry answered itself, without a person."
  costTotal:
    label: "Estimated cost"
    definition: "The cost of all runs, estimated from the token counts and a price table. It is not a bill."
  costByModel:
    label: "Cost per model"
    definition: "Tokens and estimated cost for each model. A model that is not known is counted as custom."
  costByStep:
    label: "Cost per built-in step"
    definition: "Tokens and estimated cost for each step of the built-in flows."
  modelFallbacks:
    label: "Model fallbacks"
    definition: "The number of times a step moved to another model because the first one was at its limit."
  sharing:
    label: "Installs and accounts that share"
    definition: "The installs, and the accounts on them, that shared in the last 7 days. This is its own time range and does not change with the period."
  installsPerWeek:
    label: "Installs per week"
    definition: "The number of different installs that shared in each week. It is not the sum of the days."
  bySource:
    label: "Runs per watcher source"
    definition: "The number of runs by what started them: issues, pull request feedback, CI failures, a schedule, the monitor or by hand."
  byFlow:
    label: "Runs per built-in flow"
    definition: "The number of runs of each built-in flow. Your own flows are counted as custom."
---

## How the numbers are collected

Sharing is optional. Each person account on an install is asked once. If the answer is yes, the install sends one
report a day, after the UTC day has ended. A report holds numbers only: no repository, branch, issue, title, file,
prompt, output, account name or e-mail address. The page [Privacy: shared metrics](/privacy/metrics/) says exactly
what is shared and what never is, and how to stop. The [user guide](/guide/15-sharing-metrics/) shows how to look at a report before it is sent.

A small receiver adds the reports up every hour. This page reads the result from [`/metrics.json`](/metrics.json) in
your browser. The website never calls an install.

Some things to know when you read the numbers:

- Every shared number is shown, also when only one install gave it. While few installs share, a number can come
  from a single install.
- Per day there are the last 35 days. Before that there are weeks. **Last 30 days** uses the days. **Last 90 days**
  uses the weeks that start within 90 days, so it can leave out the first days of the period. **All time** is every
  week the receiver still holds; it keeps reports for 400 days.
- The outcome measures (such as rework and merge rate) are worked out on each install for each day and then added.
  Work that was delivered on one day and reworked on the next is not counted as rework here, so these numbers
  can be lower than in the app, which looks at a longer window.
- Times and parts come from buckets, so they are close, not exact.
