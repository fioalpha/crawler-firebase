import fs from "node:fs/promises";
import path from "node:path";
import { launchBrowser } from "./browser.js";
import { ensureLoggedIn } from "./login.js";
import { resolveProjectId } from "./projectSelect.js";
import { openCrashlytics, scrapeCrashFreeMetrics, scrapeIssues, scrapeStackTrace } from "./crashlytics.js";
import { OUTPUT_DIR } from "./config.js";

const args = new Set(process.argv.slice(2));
const loginOnly = args.has("--login-only");
const resetProject = args.has("--reset-project");


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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


    // await sleep(100000);

    const projectId = await resolveProjectId(page, resetProject);

    console.log(`Opening Crashlytics for project "${projectId}"...`);
    await openCrashlytics(page, projectId);

    console.log("Scraping crash-free metrics...");
    const crashFreeMetrics = await scrapeCrashFreeMetrics(page);

    console.log("Scraping issue list...");
    const issues = await scrapeIssues(page);
    console.log(`Found ${issues.length} issue(s). Pulling stack traces...`);

    for (const issue of issues) {
      issue.stackTrace = await scrapeStackTrace(page, issue);
      // Crashlytics detail pages navigate the same tab away from the issues list,
      // so head back before the next issue's link can be looked up again.
      await page.goBack({ waitUntil: "networkidle" }).catch(() => {});
    }

    const result = {
      crawledAt: new Date().toISOString(),
      projectId,
      crashFreeMetrics,
      issues,
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
