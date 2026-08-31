import fs from "node:fs/promises";
import { STATE_FILE } from "./config.js";

export interface CrawlerState {
  projectId?: string;
  /** Firebase's internal app id for the Android/iOS/web app last crawled within the project. */
  appId?: string;
}

export async function loadState(): Promise<CrawlerState> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(raw) as CrawlerState;
  } catch {
    return {};
  }
}

export async function saveState(state: CrawlerState): Promise<void> {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}
