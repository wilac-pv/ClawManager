import { Database } from "bun:sqlite"
import { MarketDatabase } from "../src/database"
import { createSkillHubImportStore } from "../src/skillhub-import-store"

const [databasePath, workerID, barrierPath] = process.argv.slice(2)
if (!databasePath || !workerID || !barrierPath) throw new Error("missing claim race worker argument")

while (!(await Bun.file(barrierPath).exists())) await Bun.sleep(1)

const database = new MarketDatabase(new Database(databasePath, { readwrite: true }))
database.connection.run("PRAGMA busy_timeout = 5000")
database.connection.run("PRAGMA foreign_keys = ON")
const claimed = createSkillHubImportStore({ database }).claim(workerID, 3, 60_000)
console.log(JSON.stringify(claimed.map((item) => item.slug)))
database.close()
