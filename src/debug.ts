import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { DEBUG_DIR } from "./config.js";

/**
 * Firebase's console DOM isn't public and changes over time, so any selector in this
 * project is a best guess. Whenever a scrape step can't find what it expects, call this
 * to dump a screenshot + the visible text of the page — that dump is what lets the
 * selectors get corrected against the real, current DOM instead of guessed at again blind.
 */
export async function dumpDebugState(page: Page, label: string): Promise<string> {
  await fs.mkdir(DEBUG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(DEBUG_DIR, `${stamp}_${label}`);

  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => "");
  await fs.writeFile(`${base}.html`, html, "utf8");
  const text = await page.locator("body").innerText().catch(() => "");
  await fs.writeFile(`${base}.txt`, text, "utf8");

  return base;
}
