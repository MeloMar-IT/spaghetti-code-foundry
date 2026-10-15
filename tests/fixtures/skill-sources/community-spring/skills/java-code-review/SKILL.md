---
name: java-code-review
description: Review Java changes for null handling, resource closing and unclear error handling.
tags: [java, review]
technologies:
  java: ">=17"
---

# Java code review

Look at each changed method. Ask what happens for a missing value and for a failure.
Check that every opened resource is closed. Check that errors keep their cause.
List findings by severity, each with the line and a short fix.
