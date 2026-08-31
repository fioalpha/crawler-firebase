import prompts from "prompts";
import type { Page } from "playwright";
import { FIREBASE_CONSOLE_URL } from "./config.js";
import { dumpDebugState } from "./debug.js";
import { loadState, saveState } from "./state.js";

const PROJECT_HREF_RE = /\/project\/([^/?#]+)/;

interface ProjectLink {
  id: string;
  name: string;
}

/**
 * Firebase console links every project tile/link to `/project/<id>/...`. Rather than
 * guess at a specific card/grid selector (which Firebase has changed before), this just
 * scans every link on the picker page for that URL shape — resilient to the picker being
 * a grid, a list, or a table row, as long as the href pattern holds.
 */
async function listVisibleProjects(page: Page): Promise<ProjectLink[]> {
  const links = page.locator(`a[href*="/project/"]`);
  // The picker's own network traffic goes idle before the project list actually renders
  // (it loads asynchronously below the "Welcome" section) — wait for a real link first.
  await links.first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const count = await links.count();
  const seen = new Map<string, string>();

  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    const href = await link.getAttribute("href");
    if (!href) continue;
    const match = href.match(PROJECT_HREF_RE);
    if (!match) continue;
    const id = match[1];
    if (id === "_" || seen.has(id)) continue;
    const text = (await link.innerText().catch(() => "")).trim();
    seen.set(id, text || id);
  }

  return [...seen.entries()].map(([id, name]) => ({ id, name }));
}

/**
 * Resolves which Firebase project to crawl. A project picked once is remembered in
 * state.json and reused silently on every later run; use `--reset-project` to be asked
 * again (e.g. switching to a different app).
 */
export async function resolveProjectId(page: Page, forceReselect: boolean): Promise<string> {
  const state = await loadState();
  if (state.projectId && !forceReselect) {
    console.log(`Using saved project: ${state.projectId} (run with --reset-project to change)\n`);
    return state.projectId;
  }

  await page.goto(FIREBASE_CONSOLE_URL, { waitUntil: "domcontentloaded" });

  const projects = await listVisibleProjects(page);
  if (projects.length === 0) {
    const dump = await dumpDebugState(page, "no-projects-found");
    throw new Error(
      `Couldn't find any project links on the Firebase console picker page. ` +
        `Dumped what the page looked like to ${dump}.* — Firebase may have changed the ` +
        `picker layout, or there's nothing to select yet. Open ${dump}.png to check.`,
    );
  }

  const { projectId } = await prompts({
    type: "select",
    name: "projectId",
    message: "Which Firebase project should the crawler use?",
    choices: projects.map((p) => ({ title: `${p.name} (${p.id})`, value: p.id })),
  });

  if (!projectId) {
    throw new Error("No project selected — aborting.");
  }

  await saveState({ ...state, projectId, appId: undefined });
  return projectId as string;
}
