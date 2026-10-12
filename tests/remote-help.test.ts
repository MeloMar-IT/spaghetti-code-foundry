import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findUserByEmail } from "../src/auth/users.js";
import { checkReply } from "../src/help/contract.js";
import { addQuestion, finishTurn } from "../src/help/store.js";
import { HELP } from "../src/remote/areas/help.js";
import { specProblems } from "../src/remote/spec.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { remoteWorld, type RemoteWorld } from "./helpers/remote.js";

let w: RemoteWorld;
let kc: FakeKeychain;
let ann: string;
let id: string;
const ask = (words: string[], o: { as?: string; answers?: string[]; tty?: boolean } = {}) => w.scf(["ask", ...words], { as: ann, ...o });

beforeAll(async () => {
  kc = fakeKeychain();
  w = await remoteWorld();
  ann = await w.signIn("ann@example.com");
  const turn = addQuestion(findUserByEmail("ann@example.com")!.id, { question: "What is a run?" });
  finishTurn(turn.conversation.id, { message: turn.reply.id, tries: 1 }, checkReply({ summary: "A run is one start of a flow." }, { role: "user" })!.reply);
  id = turn.conversation.id;
});
afterAll(() => {
  w.close();
  kc.remove();
});

describe("scf ask", () => {
  it("is a table of calls the server knows", () => {
    expect(specProblems(HELP)).toEqual([]);
    expect(HELP.every((c) => c.area === "ask")).toBe(true);
  });

  it("lists and shows your own conversations, and none of another account", async () => {
    const list = await ask(["list"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain("What is a run?");
    const shown = await ask(["show", id]);
    expect(shown.out).toContain("You:\nWhat is a run?");
    expect(shown.out).toContain("Ask SCF:\nA run is one start of a flow.");
    expect((await w.scf(["ask", "list"])).out).toBe("no conversations");
    expect((await w.scf(["ask", "show", id])).code).not.toBe(0);
  });

  it("archives, restores and completes, and deletes only after a yes", async () => {
    expect((await ask(["archive", id, "--json"])).json<{ state: string }>().state).toBe("archived");
    expect((await ask(["list", "--archived"])).out).toContain("What is a run?");
    expect((await ask(["restore", id, "--json"])).json<{ state: string }>().state).toBe("active");
    expect((await ask(["complete", id, "--json"])).json<{ state: string }>().state).toBe("completed");
    const refused = await ask(["delete", id], { tty: true, answers: ["no"] });
    expect(refused.code).not.toBe(0);
    expect((await ask(["show", id, "--json"])).json<{ state: string }>().state).toBe("completed");
    const gone = await ask(["delete", id, "--yes"]);
    expect(gone.code).toBe(0);
    expect(gone.out).toContain("deleted");
    expect((await ask(["show", id])).code).not.toBe(0);
  });
});
