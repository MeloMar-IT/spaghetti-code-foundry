import { fileURLToPath, pathToFileURL } from "node:url";

/** Where the committed screenshot baselines of this platform live. */
export const BASELINE_DIR = fileURLToPath(new URL(`./__screenshots__/${process.platform}/`, import.meta.url));
/** True when this run was started with `--update-snapshots` (set by the config). */
export const UPDATING = process.env.UI_UPDATING === "1";
/** The gallery stand-in, opened from disk. */
export const GALLERY_URL = pathToFileURL(fileURLToPath(new URL("../../docs/ui-redesign/visual-system-demo.html", import.meta.url))).href;
