import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { launchBrowser } from "./browser.js";
import { ensureLoggedIn } from "./login.js";
import { resolveProjectId } from "./projectSelect.js";
import {
  openCrashlytics,
  filterToCrashesOnly,
  filterToAnrOnly,
  scrapeCrashFreeMetrics,
  scrapeIssues,
  openIssueByIndex,
} from "./crashlytics.js";
import { OUTPUT_DIR } from "./config.js";

const args = new Set(process.argv.slice(2));
const loginOnly = args.has("--login-only");
const resetProject = args.has("--reset-project");

/** Scrapes crash-free metrics + the full issue list (with stack traces) for whatever
 *  event-type filter is currently applied on the page — call after filterToCrashesOnly
 *  or filterToAnrOnly. `label` is just for the console log lines. */
async function scrapeCurrentFilter(page: Page, label: string) {
  console.log(`Scraping ${label}: crash-free metrics...`);
  const crashFreeMetrics = await scrapeCrashFreeMetrics(page);

  console.log(`Scraping ${label}: issue list...`);
  const issues = await scrapeIssues(page);
  console.log(`Found ${issues.length} ${label} issue(s). Pulling stack traces...`);

  // Issue rows have no real href (Angular intercepts the click client-side), so each
  // one is visited by index on the live page rather than by a saved URL — see
  // openIssueByIndex for why, and why this only works against this same, unmodified list.
  for (let i = 0; i < issues.length; i++) {
    const { url, stackTrace } = await openIssueByIndex(page, i, issues[i].title);
    issues[i].url = url;
    issues[i].stackTrace = stackTrace;
  }

  return { crashFreeMetrics, issues };
}

async function main() {
  const context = await launchBrowser();
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await ensureLoggedIn(page);
    if (loginOnly) {
      console.log("Login confirmed. Session saved — future runs won't need this step.");
      return;
    }

    const projectId = await resolveProjectId(page, resetProject);

    console.log(`Opening Crashlytics for project "${projectId}"...`);
    await openCrashlytics(page, projectId);

    console.log("--- Crashes ---");
    await filterToCrashesOnly(page);
    const crashes = await scrapeCurrentFilter(page, "crash");

    console.log("--- ANRs ---");
    await filterToAnrOnly(page);
    const anrs = await scrapeCurrentFilter(page, "ANR");

    const result = {
      crawledAt: new Date().toISOString(),
      projectId,
      crashes,
      anrs,
    };

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const outFile = path.join(OUTPUT_DIR, `crawl-${result.crawledAt.replace(/[:.]/g, "-")}.json`);
    await fs.writeFile(outFile, JSON.stringify(result, null, 2), "utf8");
    console.log(`\nDone. Wrote ${outFile}`);
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error("\nCrawl failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
