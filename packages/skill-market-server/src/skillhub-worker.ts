import { runConfiguredSync } from "./sync"

export async function runSkillHubWorker(sync: () => Promise<void> = runConfiguredSync) {
  await sync()
}

if (import.meta.main) await runSkillHubWorker()
