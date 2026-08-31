import { chromium, type BrowserContext } from "playwright";
import { BROWSER_PROFILE_DIR } from "./config.js";

/**
 * Launches Chromium with a persistent, on-disk profile. Google's session cookies live in
 * that profile dir, so a login done once (interactively, headed — see ensureLoggedIn) is
 * reused by every later run instead of being redone. Headless here relies on that: a
 * fresh/expired session still needs a headed run to clear login and any 2FA prompt (set
 * `headless: false` below to see the window for that), but once a session is saved,
 * headless is fine for everyday unattended crawls.
 */
export async function launchBrowser(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: [
        // '--disable-blink-features=AutomationControlled',
        // '--no-sandbox',
        // '--disable-web-security',
        // '--disable-infobars',
        // '--disable-extensions',
        // '--start-maximized',
        // '--window-size=1280,720',
    ],
    // args: [ "--disable-blink-features=AutomationControlled" ],
  });
}
