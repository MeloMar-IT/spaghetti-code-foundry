// Entry of the development gallery (/gallery/, served only with --dev).
import { start } from "./view.js";

start({ location: window.location, history: window.history });
