import type { Page } from "playwright";
import { dumpDebugState } from "./debug.js";

export interface CrashFreeMetrics {
  [label: string]: string;
}

export interface CrashIssue {
  title: string;
  url: string | null;
  /** Raw text of the row's table cell (subtitle, event/user counts, etc.) — kept whole
   *  because Crashlytics doesn't label those cells with anything selector-friendly. */
  rowText: string;
  stackTrace?: string;
}

/**
 * Opens the given project's overview, then does literally what was asked: finds the
 * "Crashlytics" entry in the console's left nav and clicks it. The nav renders its items
 * as `<a href=".../<projectId>/crashlytics">`, which is a much less ambiguous target than
 * matching on the word "Crashlytics" alone (that text also shows up elsewhere on the page,
 * e.g. in the product catalog).
 */
export async function openCrashlytics(page: Page, projectId: string): Promise<void> {
  await page.goto(`https://console.firebase.google.com/project/${projectId}/overview`, {
    waitUntil: "domcontentloaded",
  });

  const navLink = page.locator(`a[href*="/${projectId}/crashlytics"]`).first();

  // The overview page's own network traffic goes idle well before Angular finishes
  // hydrating the sidebar, so this waits for the link itself rather than for the network.
  const found = await navLink
    .waitFor({ state: "visible", timeout: 20_000 })
    .then(() => true)
    .catch(() => false);

  if (!found) {
    const dump = await dumpDebugState(page, "crashlytics-nav-not-found");
    throw new Error(
      `Couldn't find a "Crashlytics" nav item on the project overview page after 20s. ` +
        `Dumped the page to ${dump}.* — check ${dump}.png. Firebase may have moved it ` +
        `under a "Release & Monitor" submenu, or Crashlytics isn't set up for this project yet.`,
    );
  }

  await navLink.click();

  // Confirm the click actually navigated (Firebase's URL updates to include /crashlytics),
  // not just that the click event fired.
  await page
    .waitForURL((url) => url.toString().includes(`/${projectId}/crashlytics`), { timeout: 20_000 })
    .catch(() => {});

  // Give the Crashlytics dashboard's own async render (separate from page navigation) a
  // window to finish before any scraping starts. Wait on the crash-free stat card
  // component rather than any text — the console's language follows the account's
  // (this project renders in Portuguese), so English text like "Crash-free" never
  // appears, but the <fire-big-tab-scorecard-header> element is always there regardless
  // of language and shows up even when there's no issue data yet.
  await page
    .locator("fire-big-tab-scorecard-header")
    .first()
    .waitFor({ state: "visible", timeout: 20_000 })
    .catch(() => {});
}

/**
 * Scrapes the crash-free users/sessions stat cards on the Crashlytics dashboard. Reads
 * via <fire-big-tab-scorecard-title>/<...-subtitle> (label/value) rather than matching
 * "Crash-free" text, because the console's language follows the Google account — this
 * project's console renders in Portuguese, and the component tag names are the only part
 * of this that's stable across languages.
 */
export async function scrapeCrashFreeMetrics(page: Page): Promise<CrashFreeMetrics> {
  const metrics: CrashFreeMetrics = {};
  const headers = page.locator("fire-big-tab-scorecard-header");
  // .count() reads the DOM as it is right now, with no auto-wait — give the dashboard's
  // async render a chance to land the stat cards before asking how many there are.
  await headers.first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const count = await headers.count();

  for (let i = 0; i < count; i++) {
    const header = headers.nth(i);
    const label = (await header.locator("fire-big-tab-scorecard-title").innerText().catch(() => "")).trim();
    const value = (await header.locator("fire-big-tab-scorecard-subtitle").innerText().catch(() => "")).trim();
    if (label) metrics[label] = value;
  }

  if (count === 0) {
    const dump = await dumpDebugState(page, "crash-free-metrics-not-found");
    console.warn(
      `Warning: no crash-free stat cards found. Dumped page to ${dump}.* to inspect.`,
    );
  }

  return metrics;
}

/**
 * Scrapes the issues list/table on the Crashlytics dashboard. Issue rows render as
 * `<a class="link-wrapper" href="#">` — Angular's router intercepts the click and
 * navigates client-side, so the real destination URL isn't available up front the way a
 * normal link's href would give it. This only reads title/subtitle/stats here; use
 * `openIssueByIndex` afterwards to actually visit one and learn its URL.
 */
export async function scrapeIssues(page: Page): Promise<CrashIssue[]> {
  const titles = page.locator('[data-test-id="titleWrapper"]');
  await titles.first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const count = await titles.count();
  const issues: CrashIssue[] = [];

  for (let i = 0; i < count; i++) {
    const title = (await titles.nth(i).innerText().catch(() => "")).trim();
    // Title + subtitle + event/user counts all live in the same table cell — read the
    // whole cell via textContent (not innerText) since the event/user-count summary is
    // CSS-hidden at desktop widths and innerText returns "" for hidden nodes.
    const cell = titles.nth(i).locator("xpath=ancestor::td[1]");
    const rowText = (await cell.textContent().catch(() => ""))?.replace(/\s+/g, " ").trim() ?? "";
    if (!title && !rowText) continue;
    issues.push({ title: title || rowText, url: null, rowText });
  }

  if (issues.length === 0) {
    const dump = await dumpDebugState(page, "issues-list-not-found");
    console.warn(`Warning: no issue rows found. Dumped page to ${dump}.* to inspect.`);
  }

  return issues;
}

/**
 * Clicks into the nth issue row (0-indexed, matching `scrapeIssues`' order) and scrapes
 * its stack trace, then navigates back to the issues list. Re-queries the row by index on
 * a live page rather than a saved link, since issue rows have no real href to revisit
 * directly (see `scrapeIssues`) — this only works right after a `scrapeIssues` call, on
 * the same list (re-sorting/re-filtering between the two would shift the indices).
 */
export async function openIssueByIndex(
  page: Page,
  index: number,
  title: string,
): Promise<{ url: string; stackTrace: string | undefined }> {
  const link = page.locator('[data-test-id="titleWrapper"]').nth(index).locator("xpath=ancestor::a[1]");
  await link.click();
  await page.waitForLoadState("domcontentloaded");

  // "Stack trace" is a guess at the label text — this project's console is in Portuguese
  // and there's no confirmed sample of an issue detail page yet to check the real label
  // against, so a few likely variants are tried. If none hit, the debug dump below is
  // what to check to correct this against the real page.
  const heading = page.getByText(/stack ?trace|rastreamento de pilha|pilha de chamadas/i).first();
  const found = await heading
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  const url = page.url();
  let stackTrace: string | undefined;

  if (!found) {
    const dump = await dumpDebugState(page, `stack-trace-not-found_${sanitize(title)}`);
    console.warn(`Warning: no stack trace section found for issue "${title}". Dumped to ${dump}.*`);
  } else {
    const section = heading.locator("xpath=ancestor::*[self::div or self::section][1]");
    stackTrace = (await section.innerText().catch(() => undefined))?.trim();
  }

  await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
  // Same async-render gap as everywhere else: give the list time to redraw before the
  // next index is looked up.
  await page
    .locator('[data-test-id="titleWrapper"]')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});

  return { url, stackTrace };
}

function sanitize(text: string): string {
  return text.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
}
