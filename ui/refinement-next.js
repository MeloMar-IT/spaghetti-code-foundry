import { h } from "./dom.js";
import { whoClass } from "./next.js";
import { PUBLISH } from "./refinement-publish.js";
import { CHECK } from "./refinement-ready.js";

// The one sentence at the top of a session page that says what the next step is. Pure: it reads the session view the server sends.

export const ASK_BRIEF = "Ask the architect to look at the code";

const many = (n, one, other) => `${n} ${n === 1 ? one : other}`;

/** Ready drafts the publish plan can offer: one that depends on a draft that is neither ready, on GitHub nor split is held back, and so is what depends on it. */
function publishable(drafts) {
  let ok = drafts.filter((d) => d.state === "ready" && !d.published);
  const settled = (id) => {
    const o = drafts.find((x) => x.id === id);
    return !o || o.published || o.state === "split" || ok.includes(o);
  };
  for (let again = true; again; ) {
    const next = ok.filter((d) => (d.dependsOn ?? []).every((x) => x.draft === undefined || settled(x.draft)));
    again = next.length !== ok.length;
    ok = next;
  }
  return ok;
}

/** The next step of a session: { who: "You" | "The architect" | "Nobody", text } — one sentence. */
export function sessionNext(s) {
  const you = (text) => ({ who: "You", text });
  const nobody = (text) => ({ who: "Nobody", text });
  if (!s) return nobody("There is nothing to do here.");
  const drafts = s.draftsHidden ? [] : (s.drafts ?? []);
  const talk = s.talkHidden ? undefined : s.talk;
  if (s.state === "dropped") return nobody(s.mine ? "This session is dropped, so restore it to carry on." : "This session is dropped.");
  if (!s.mine) return nobody("Only the owner of this session can take the next step.");
  if (s.repoAvailable === false) return you("Add the repository to My repositories again to carry on.");
  const a = s.architect?.state;
  if (a === "queued" || a === "running") return { who: "The architect", text: "The architect is at work, and the page updates by itself." };
  if (a === "paused") return you("The architect paused, so press Ask again to let it carry on.");
  if (a === "failed") return you("The architect could not finish, so press Try again or carry on without it.");
  if (s.source?.replace === "due") return you(`Press ${PUBLISH} to finish replacing issue #${s.source.issue}.`);
  if (s.state === "published") return nobody("Nothing more to do: every story is on GitHub.");
  const ready = publishable(drafts).length;
  if (ready) return you(ready === 1 ? `1 story is ready, so press ${PUBLISH} to put it on GitHub.` : `${ready} stories are ready, so press ${PUBLISH} to put them on GitHub.`);
  const last = talk?.rounds?.at(-1);
  const unanswered = (last?.questions ?? []).filter((q) => !q.answer).length;
  if (unanswered) return you(`Answer the architect's ${many(unanswered, "question", "questions")}, and "I don't know yet" counts as an answer.`);
  const proposed = talk?.proposals?.length ?? 0;
  if (proposed) return you(`Accept or reject the ${many(proposed, "entry", "entries")} the architect proposed for the map.`);
  if (!drafts.length) {
    if (!s.brief) return you(`${ASK_BRIEF}, or write your first story draft.`);
    if (!talk?.rounds?.length) return you("Ask the architect for questions, or write your first story draft.");
    return you("Write your first story draft.");
  }
  const open = talk?.map?.open?.length ?? 0;
  if (open) return you(`Settle the ${many(open, "open question", "open questions")}, because a story with open questions is not ready.`);
  const drafting = drafts.filter((d) => d.state !== "split" && !d.published);
  if (drafting.some((d) => !d.readiness)) return you(`Finish the story draft and press ${CHECK}.`);
  if (drafting.some((d) => d.readiness.stale)) return you(`The Definition of Ready changed, so press ${CHECK} again.`);
  if (!s.brief && drafting.some((d) => (d.readiness.items ?? []).some((i) => i.result === "unsure"))) return you(`${ASK_BRIEF}, then press ${CHECK} again.`);
  const accepted = (d, i) => (d.acceptedAnyway ?? []).some((x) => x.id === i.id);
  const rest = drafting.flatMap((d) => (d.readiness.items ?? []).filter((i) => i.result !== "met" && !accepted(d, i)));
  if (rest.length && rest.every((i) => i.id === "no-plan")) return you(`Move the implementation plan out of the story, then press ${CHECK} again.`);
  return you("Fix what the readiness check found, or accept an item anyway with a reason.");
}

/** The card: text only, never HTML. */
export function nextNode(s) {
  const n = sessionNext(s);
  return h("div", { class: `card next-step ${whoClass(n)}` }, h("b", {}, "What happens next"), h("span", { class: "hold-action" }, n.text));
}
