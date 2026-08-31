import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "..");

/** Persistent Chromium profile dir — keeps the Google login session across runs. */
export const BROWSER_PROFILE_DIR = path.join(ROOT_DIR, ".browser-profile");

/** Remembers which Firebase project (and, once known, which app) to crawl. */
export const STATE_FILE = path.join(ROOT_DIR, "state.json");

/** Timestamped JSON crawl results land here. */
export const OUTPUT_DIR = path.join(ROOT_DIR, "output");

/** Raw page dumps (HTML/text/screenshots) written whenever a scrape step can't find what it expects. */
export const DEBUG_DIR = path.join(ROOT_DIR, "debug");

export const FIREBASE_CONSOLE_URL = "https://console.firebase.google.com/";
