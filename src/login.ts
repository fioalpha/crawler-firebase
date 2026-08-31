import type { Page } from "playwright";
import { FIREBASE_CONSOLE_URL } from "./config.js";

const LOGIN_HOST_MARKERS = ["accounts.google.com"];

function isOnLoginPage(url: string): boolean {
  return LOGIN_HOST_MARKERS.some((marker) => url.includes(marker));
}

/**
 * Makes sure the persistent browser context is signed into a Google account that can see
 * Firebase console. If the saved profile already has a session, this resolves almost
 * immediately. Otherwise it waits — for as long as it takes — for a human to finish the
 * Google login (including any 2FA) in the visible browser window; once Firebase console
 * loads, the session is saved in the profile dir for every future run.
 */
export async function ensureLoggedIn(page: Page): Promise<void> {
  await page.goto(FIREBASE_CONSOLE_URL, { waitUntil: "domcontentloaded" });

  if (!isOnLoginPage(page.url())) {
    return;
  }

  console.log("\nNot logged in yet.");
  console.log("A Chrome window is open — sign into the Google account that has access");
  console.log("to your Firebase project there (complete 2FA if prompted).");
  console.log("Waiting for that to finish...\n");

  await page.waitForURL((url) => !isOnLoginPage(url.toString()), {
    timeout: 10 * 60 * 1000, // 10 minutes to complete manual login
  });

  // Google sometimes bounces through accounts.google.com more than once before landing.
  await page.waitForLoadState("domcontentloaded");
  console.log("Logged in.\n");
}
