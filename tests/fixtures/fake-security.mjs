#!/usr/bin/env node
// A fake of /usr/bin/security for the three calls the credential store makes.
// The logic and its FAKE_KEYCHAIN_* switches are in fake-keychain-core.mjs.
import { readFileSync } from "node:fs";
import { fakeSecurity } from "./fake-keychain-core.mjs";

const args = process.argv.slice(2);
const input = args[0] === "add-generic-password" ? readFileSync(0, "utf8") : "";
const r = fakeSecurity(args, input);
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exitCode = r.status;
