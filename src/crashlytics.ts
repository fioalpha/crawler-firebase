import type { Locator, Page } from "playwright";
import { dumpDebugState } from "./debug.js";

export interface CrashFreeMetrics {
  [label: string]: string;
}

export interface CrashIssue {
  /** The issue's title, usually `<Class>.<method>` — e.g. "MainActivity.onCreate". */
  title: string;
  /** The exception type shown under the title, e.g. "java.lang.Exception". `null` if the
   *  row had no subtitle element (rare, but the DOM doesn't guarantee one). */
  subtitle: string | null;
  /** Deep link straight to this issue's detail page. `null` until `openIssueByIndex` has
   *  actually visited it — issue rows have no real href to read this from up front (see
   *  `scrapeIssues`'s doc comment), so this is only filled in as a side effect of scraping
   *  the stack trace, never populated by `scrapeIssues` alone. */
  url: string | null;
  /** Number of crash events for this issue in the dashboard's current time window, as
   *  Crashlytics displays it (e.g. "3"). Read from the table's `cdk-column-eventCount`
   *  cell — a raw string, not parsed to a number, in case Crashlytics ever formats large
   *  counts (e.g. "1.2K"). */
  eventCount: string | null;
  /** Number of distinct users affected, same caveats as `eventCount` (`cdk-column-userCount`). */
  userCount: string | null;
  /** App version range the issue was seen in, e.g. "1.0 – 1.0" (`cdk-column-versions`). */
  versionRange: string | null;
  /**
   * Best-effort only: the Trends column is a canvas-rendered sparkline chart, not text, so
   * there's no way to read its actual per-day series. This is just the value range pulled
   * out of the chart's screen-reader description (e.g. "0–3"), when Firebase provides one —
   * it's the y-axis min/max, not a summary of the trend's shape (rising/falling/flat).
   */
  trendRange: string | null;
  /** Raw text of the row's title cell (crash type, package, blamed file, tags, etc.) —
   *  kept whole because Crashlytics doesn't label most of it with anything selector-friendly.
   *  Useful as a fallback/debugging aid if one of the structured fields above comes back
   *  `null` on a row shape this hasn't been tested against. */
  rowText: string;
  /** The parsed stack trace text (exception, causal chain, file:line frames) from the
   *  issue's detail page, with Material icon-font noise stripped. `undefined` until
   *  `openIssueByIndex` has visited the issue, or if no stack trace section was found for
   *  it (see the `stack-trace-not-found_*` debug dump in that case). */
  stackTrace?: string;
}

/** Reads one column's cell text for a row, by the table's own (locale-independent) column
 *  class name — Angular Material emits `cdk-column-<field>` from the English field name
 *  the table is configured with, regardless of what the console's display language is. */
async function readColumnCell(row: Locator, columnClass: string): Promise<string | null> {
  const text = await row
    .locator(`td.${columnClass}`)
    .textContent()
    .catch(() => null);
  return text?.replace(/\s+/g, " ").trim() || null;
}

/**
 * Pulls "0–2" out of the trends chart's y-axis screen-reader description, if present.
 * Scoped to `<ac-y-axis>` specifically (not the whole trends cell) because the cell's
 * other screen-reader text — the x-axis's date-range sentence — has numbers of its own
 * (day/month/year) that would otherwise get matched first.
 */
async function readTrendRange(row: Locator): Promise<string | null> {
  const axisText = await row
    .locator("td.cdk-column-trends ac-y-axis")
    .first()
    .textContent()
    .catch(() => null);
  const match = axisText?.match(/(-?[\d.,]+)\D+(-?[\d.,]+)/);
  return match ? `${match[1]}–${match[2]}` : null;
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
    const titleEl = titles.nth(i);
    const title = (await titleEl.innerText().catch(() => "")).trim();

    // Title + subtitle live in the same <a>; event/user/version/trend are separate <td>
    // cells in the same <tr> — go up to the row once and read everything from there.
    const cell = titleEl.locator("xpath=ancestor::td[1]");
    const row = titleEl.locator("xpath=ancestor::tr[1]");

    const subtitle =
      (await cell
        .locator('[data-test-id="subtitleWrapper"]')
        .innerText()
        .catch(() => "")
      ).trim() || null;

    // textContent (not innerText) here: the mobile event/user summary text inside this
    // cell is CSS-hidden at desktop widths, and innerText returns "" for hidden nodes.
    const rowText = (await cell.textContent().catch(() => ""))?.replace(/\s+/g, " ").trim() ?? "";

    const eventCount = await readColumnCell(row, "cdk-column-eventCount");
    const userCount = await readColumnCell(row, "cdk-column-userCount");
    const versionRange = await readColumnCell(row, "cdk-column-versions");
    const trendRange = await readTrendRange(row);

    if (!title && !rowText) continue;
    issues.push({
      title: title || rowText,
      subtitle,
      url: null,
      eventCount,
      userCount,
      versionRange,
      trendRange,
      rowText,
    });
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
    // "Stack trace" is a *tab label* (in a session-card's mat-tab-group), not a heading
    // over the trace itself — the trace lives in a separate panel `<mat-tab-body>` that
    // aria-controls points to, and that panel's content loads asynchronously (it's still
    // an empty placeholder right when the tab label first appears).
    const tab = heading.locator("xpath=ancestor::div[@role='tab'][1]");
    const panelId = await tab.getAttribute("aria-controls").catch(() => null);

    if (!panelId) {
      const dump = await dumpDebugState(page, `stack-trace-not-found_${sanitize(title)}`);
      console.warn(
        `Warning: found a "Stack trace" tab for issue "${title}" but no aria-controls ` +
          `pointing at its content panel. Dumped to ${dump}.*`,
      );
    } else {
      await page
        .waitForFunction(
          (id) => {
            const el = document.getElementById(id);
            return !!el && el.innerText.trim().length > 0;
          },
          panelId,
          { timeout: 20_000 },
        )
        .catch(() => {});
      const rawText = (await page.locator(`#${panelId}`).innerText().catch(() => undefined))?.trim();
      stackTrace = rawText && stripIconLigatureNoise(rawText);
    }
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

/**
 * The stack trace panel is a Material icon font (expand/collapse chevrons, a copy button,
 * etc.) sitting right alongside the actual trace text — those icons render as literal text
 * nodes containing their ligature name (e.g. "keyboard_arrow_up"), which innerText can't
 * tell apart from real content. Drops lines that are just a bare icon token: real stack
 * trace lines always have punctuation (a paren, colon, or dot) an icon name never does.
 */
function stripIconLigatureNoise(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^[a-z][a-z_]*$/.test(line.trim()))
    .join("\n")
    .trim();
}

function sanitize(text: string): string {
  return text.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
}
