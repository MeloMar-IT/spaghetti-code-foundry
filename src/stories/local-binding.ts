import { findLocalRepo } from "../auth/repos.js";
import { LocalStore } from "./local-store.js";
import { STORIES_BRANCH } from "./story-commit.js";
import type { StoryStore } from "./store.js";

// Loaded on demand by `storeFor` (a dynamic import): this file pulls in the repository registry and the local store, which need
// packages (zod, yaml) that a process with only `dist/` and `package.json` does not have.

/** The store of a connected local repository: stories in its folder, committed on the separate `scf/stories` branch. */
export function localStoreFor(repo: string): StoryStore {
  const rec = findLocalRepo(repo);
  if (!rec) throw new Error("no local repository is connected as " + repo);
  return new LocalStore(rec.url, repo, { branch: STORIES_BRANCH });
}
