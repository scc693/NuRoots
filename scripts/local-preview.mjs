import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createTestHarness, unstable_splitSqlQuery } from "wrangler";

export async function startPreview() {
  const runtime = createTestHarness({
    workers: [{ configPath: "./wrangler.jsonc", secrets: { AUTH_RATE_SECRET: randomBytes(32).toString("hex") } }],
  });
  try {
    const { url } = await runtime.listen();
    const worker = runtime.getWorker();
    const { DB: db } = await worker.getEnv();
    const load = async path => {
      const sql = await readFile(new URL(path, import.meta.url), "utf8");
      await db.batch(unstable_splitSqlQuery(sql).map(statement => db.prepare(statement)));
    };
    await load("../schema.sql");
    await worker.applyD1Migrations("DB");
    await load("../fixtures/family-tree.sql");
    const password = randomBytes(18).toString("base64url");
    for (const role of ["owner", "editor", "viewer"]) {
      const email = role + "@example.test";
      const code = randomBytes(32).toString("hex");
      await db.prepare(`INSERT INTO auth_invites(email,token_hash,role,expires_at)
        VALUES (?, ?, ?, unixepoch()+600)`).bind(email, createHash("sha256").update(code).digest("hex"), role).run();
      const result = await worker.fetch(new URL("/join", url), { method: "POST", redirect: "manual",
        headers: { Origin: url.origin }, body: new URLSearchParams({ email, password, code }) });
      if (result.status !== 303) throw new Error("Could not create fictional " + role + " account.");
    }
    await load("../fixtures/community-preview.sql");
    await load("../fixtures/community-demo.sql");
    return { origin: url.origin, password, close: () => runtime.close() };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await startPreview();
  console.log(`Open ${preview.origin}/signin
Fictional accounts: owner@example.test, editor@example.test, viewer@example.test
Password for this run: ${preview.password}
The owner stewards Harlow, the editor stewards Bennett, and the viewer stewards Family Quilters.
Press Ctrl+C to discard this preview.`);
  await new Promise(resolve => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await preview.close();
}
