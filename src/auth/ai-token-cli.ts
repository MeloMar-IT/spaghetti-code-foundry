import { inheritedEnv } from "../steps/process.js";
import { aiTokenSource, clearAiToken, envAiTokenVar, setAiToken } from "./ai-token.js";
import type { UserIo } from "./cli.js";

export const AUTH_USAGE = `usage: scf auth set-token     Store the Claude token in the macOS Keychain; takes no operand or option.
                              The token is asked on a terminal, or read from the first line of stdin
       scf auth status        Show which sign-in is used (environment, keychain or none) and when the token was set
       scf auth clear-token   Remove the token from the Keychain`;

const SUBCOMMANDS = ["set-token", "status", "clear-token"];

/** `scf auth …`. The syntax is checked before anything is read or asked. No line ever holds the token. */
export async function aiTokenCommand(args: { positionals: string[]; values: Record<string, unknown> }, io: UserIo): Promise<number> {
  const [sub, ...operands] = args.positionals;
  if (!sub || !SUBCOMMANDS.includes(sub) || operands.length || Object.values(args.values).some((v) => v !== undefined)) throw new Error(AUTH_USAGE);

  if (sub === "set-token") {
    const token = io.isTTY ? await io.askHidden("Claude token: ") : await io.readStdinLine();
    if (!token) throw new Error(io.isTTY ? "no token given" : "no token on stdin: give it as the first line");
    setAiToken(token);
    io.out("the token is stored in the Keychain");
    const variable = envAiTokenVar(inheritedEnv());
    if (variable) io.out(`note: ${variable} is set here, and a variable wins over the Keychain`);
    return 0;
  }
  if (sub === "clear-token") {
    io.out(clearAiToken() ? "the token was removed from the Keychain" : "there is no token in the Keychain");
    return 0;
  }
  const s = aiTokenSource((line) => (io.err ?? io.out)(line));
  io.out(`source: ${s.source}${s.variable ? ` (${s.variable})` : ""}`);
  if (s.source === "keychain") io.out(`set: ${s.setAt ?? "unknown"}`);
  if (s.source === "environment" && s.setAt) io.out(`set: ${s.setAt} (the Keychain token, which is not used while a variable is set)`);
  return s.unreadable ? 1 : 0;
}
