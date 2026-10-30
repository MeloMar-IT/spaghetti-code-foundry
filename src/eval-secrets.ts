import { z } from "zod";
import { hideKeyVars } from "./credentials/redact.js";

/** A fake key an eval sets in the server's environment. The name must start with `SCF_EVAL_`: no real key or `PATH` can be named. */
export const FakeSecretSchema = z
  .object({
    name: z.string().regex(/^SCF_EVAL_[A-Z0-9_]{1,40}$/, "must start with SCF_EVAL_ (capitals, digits, _)"),
    value: z.string().min(16).max(200).regex(/^[A-Za-z0-9._-]+$/, "letters, digits, . _ - only"),
  })
  .strict();

export type FakeSecret = z.infer<typeof FakeSecretSchema>;

/** Names we hold: how many registrations are live, and whether we set the variable (so we may remove it). */
const held = new Map<string, { count: number; setByUs: boolean }>();

/**
 * Sets the fake keys in the real environment and hides their values in logs, outputs and the stored diff.
 * Checks everything first and throws before it changes anything. Returns an idempotent function that undoes it:
 * the variable goes when the last holder lets go, and only if we set it.
 */
export function registerFakeSecrets(secrets: FakeSecret[]): () => void {
  const values = new Map<string, string>();
  for (const s of secrets) {
    const other = values.get(s.name);
    if (other !== undefined && other !== s.value) throw new Error(`fake_secret ${s.name}: two cases give it different values`);
    values.set(s.name, s.value);
  }
  for (const [name, value] of values) {
    const now = process.env[name];
    if (now !== undefined && now !== value) throw new Error(`fake_secret ${name}: already set in the environment`);
  }
  for (const [name, value] of values) {
    const h = held.get(name);
    if (h) h.count++;
    else {
      const setByUs = process.env[name] === undefined;
      if (setByUs) process.env[name] = value;
      held.set(name, { count: 1, setByUs });
    }
  }
  hideKeyVars(values.keys());
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const name of values.keys()) {
      const h = held.get(name);
      if (!h || --h.count > 0) continue;
      held.delete(name);
      if (h.setByUs) delete process.env[name];
    }
  };
}
