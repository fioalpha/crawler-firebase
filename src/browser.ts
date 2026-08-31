import { chromium, type BrowserContext } from "playwright";
import { BROWSER_PROFILE_DIR } from "./config.js";

/**
 * Launches Chromium with a persistent, on-disk profile. Google's session cookies live in
 * that profile dir, so a login done once (interactively, on a first run) is reused by
 * every later run instead of being redone. Runs headed on purpose: headless Chromium gets
 * flagged and blocked by Google's login flow, and a human needs to be able to see the
 * window to clear a 2FA prompt the first time.
 */
export async function launchBrowser(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless: false,
    viewport: { width: 1440, height: 900 },
  });
}
