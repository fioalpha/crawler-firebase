import type { Page } from "playwright";
import { dumpDebugState } from "./debug.js";

export interface CrashFreeMetrics {
  [label: string]: string;
}

export interface CrashIssue {
  title: string;
  url: string | null;
  /** Raw text of the row (event count, affected users, trend, etc.) — kept whole because
   *  Crashlytics doesn't label these cells with anything selector-friendly. */
  rowText: string;
  stackTrace?: string;
}

/**
 * Opens the given project's overview, then does literally what was asked: finds the
 * "Crashlytics" entry in the console's left nav and clicks it. Firebase nav items render
 * as links or buttons depending on the section, so both roles are tried.
 */
export async function openCrashlytics(page: Page, projectId: string): Promise<void> {
  await page.goto(`https://console.firebase.google.com/project/${projectId}/overview`, {
    waitUntil: "networkidle",
  });

  const candidates = [
    page.getByRole("link", { name: /crashlytics/i }),
    page.getByRole("button", { name: /crashlytics/i }),
    page.getByText(/^crashlytics$/i),
  ];

  for (const candidate of candidates) {
    if (await candidate.first().isVisible().catch(() => false)) {
      await candidate.first().click();
      await page.waitForLoadState("networkidle");
      return;
    }
  }

  const dump = await dumpDebugState(page, "crashlytics-nav-not-found");
  throw new Error(
    `Couldn't find a "Crashlytics" nav item on the project overview page. ` +
      `Dumped the page to ${dump}.* — check ${dump}.png. Firebase may have moved it ` +
      `under a "Release & Monitor" submenu, or Crashlytics isn't set up for this project yet.`,
  );
}

/** Scrapes the crash-free users/sessions stat cards on the Crashlytics dashboard. */
export async function scrapeCrashFreeMetrics(page: Page): Promise<CrashFreeMetrics> {
  const metrics: CrashFreeMetrics = {};
  const labels = page.getByText(/crash-free (users|sessions)/i);
  const count = await labels.count();

  for (let i = 0; i < count; i++) {
    const label = labels.nth(i);
    const labelText = (await label.innerText()).trim();
    // The percentage is usually a sibling/nearby node, not inside the label itself —
    // read the whole stat card's text and pull the first "NN.N%" out of it.
    const cardText = await label
      .locator("xpath=ancestor::*[self::div or self::section][1]")
      .innerText()
      .catch(() => labelText);
    const match = cardText.match(/\d{1,3}(?:\.\d+)?\s*%/);
    metrics[labelText] = match ? match[0] : cardText.trim();
  }

  if (count === 0) {
    const dump = await dumpDebugState(page, "crash-free-metrics-not-found");
    console.warn(
      `Warning: no "Crash-free users/sessions" stat found. Dumped page to ${dump}.* to inspect.`,
    );
  }

  return metrics;
}

/** Scrapes the issues list/table on the Crashlytics dashboard. */
export async function scrapeIssues(page: Page): Promise<CrashIssue[]> {
  const rows = page.locator(`a[href*="/issues/"]`);
  const count = await rows.count();
  const issues: CrashIssue[] = [];
  const seenUrls = new Set<string>();

  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const href = await row.getAttribute("href");
    const url = href ? new URL(href, page.url()).toString() : null;
    if (url && seenUrls.has(url)) continue;
    if (url) seenUrls.add(url);

    const rowText = (await row.innerText().catch(() => "")).trim();
    if (!rowText) continue;

    const title = rowText.split("\n")[0]?.trim() || rowText;
    issues.push({ title, url, rowText });
  }

  if (issues.length === 0) {
    const dump = await dumpDebugState(page, "issues-list-not-found");
    console.warn(`Warning: no issue rows found. Dumped page to ${dump}.* to inspect.`);
  }

  return issues;
}

/** Drills into one issue's detail page and pulls out the stack trace text, then returns. */
export async function scrapeStackTrace(page: Page, issue: CrashIssue): Promise<string | undefined> {
  if (!issue.url) return undefined;

  await page.goto(issue.url, { waitUntil: "networkidle" });

  const heading = page.getByText(/stack trace/i).first();
  if (!(await heading.isVisible().catch(() => false))) {
    const dump = await dumpDebugState(page, `stack-trace-not-found_${sanitize(issue.title)}`);
    console.warn(
      `Warning: no "Stack trace" section found for issue "${issue.title}". Dumped to ${dump}.*`,
    );
    return undefined;
  }

  const section = heading.locator("xpath=ancestor::*[self::div or self::section][1]");
  const text = await section.innerText().catch(() => undefined);
  return text?.trim();
}

function sanitize(text: string): string {
  return text.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
}
