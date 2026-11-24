// Exercise Wrangler's local D1 migration and recovery paths with fictional data.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "nuroots-restore-"));
const wrangler = join(repo, "node_modules/wrangler/bin/wrangler.js");
function d1(dir, ...args) {
  return execFileSync(process.execPath, [wrangler, "d1", ...args, "--local"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
}
function query(dir, sql) {
  return JSON.parse(d1(dir, "execute", "DB", "--command", sql, "--json"));
}

try {
  const source = join(temporary, "source");
  const restored = join(temporary, "restored");
  for (const dir of [source, restored]) {
    await mkdir(dir);
    await cp(join(repo, "wrangler.jsonc"), join(dir, "wrangler.jsonc"));
    await cp(join(repo, "migrations"), join(dir, "migrations"), { recursive: true });
  }
  d1(source, "execute", "DB", "--file", join(repo, "schema.sql"));
  d1(source, "execute", "DB", "--file", join(repo, "fixtures/family-tree.sql"));
  query(source, "INSERT INTO members(id,email,role) VALUES ('fixture-owner','owner@example.test','owner')");
  d1(source, "migrations", "apply", "DB");
  assert.deepEqual(query(source, "SELECT DISTINCT name_version FROM people")[0].results, [{ name_version: 0 }]);
  query(source, `INSERT INTO auth_passwords VALUES ('fixture-owner','fixture-hash');
    INSERT INTO auth_sessions VALUES ('fixture-token','fixture-owner',1);
    INSERT INTO auth_invites VALUES ('pending@example.test','fixture-invite','viewer',1);
    INSERT INTO auth_attempts VALUES ('fixture-bucket',1,2);
    INSERT INTO person_citations(id,person_id,title,locator)
      VALUES ('fixture-citation','fictional-deceased','Fictional register','Volume 1, page 12');
    INSERT INTO change_log(id,actor_email,action,entity_type,entity_id,old_value,new_value)
      VALUES ('fixture-change','owner@example.test','rename','person','fictional-deceased',
        json_object('given','Eleanor','family','Bennett'),json_object('given','Nora','family','Bennett'));
    UPDATE people SET given_name = 'Nora', name_version = 1 WHERE id = 'fictional-deceased'`);
  d1(source, "execute", "DB", "--file", join(repo, "fixtures/community-preview.sql"));
  query(source, `INSERT INTO members(id,email) VALUES ('fixture-relative','relative@example.test');
    INSERT INTO community_invitations(id,community_id,recipient_id,proposer_id,expires_at)
      VALUES ('fixture-request','sample-harlow','fixture-relative','fixture-owner',1)`);
  const dump = join(temporary, "backup.sql");
  d1(source, "export", "DB", "--output", dump);
  d1(restored, "execute", "DB", "--file", dump);
  d1(restored, "migrations", "apply", "DB");
  const checks = [
    "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name",
    "SELECT * FROM people ORDER BY id",
    "SELECT * FROM relationships ORDER BY id",
    "SELECT * FROM members ORDER BY id",
    "SELECT * FROM auth_passwords ORDER BY member_id",
    "SELECT * FROM auth_sessions ORDER BY token_hash",
    "SELECT * FROM auth_invites ORDER BY email",
    "SELECT * FROM auth_attempts ORDER BY bucket",
    "SELECT * FROM change_log ORDER BY id",
    "SELECT * FROM person_citations ORDER BY id",
    "SELECT * FROM communities ORDER BY id",
    "SELECT * FROM community_memberships ORDER BY community_id,member_id",
    "SELECT * FROM community_invitations ORDER BY id",
    "SELECT * FROM d1_migrations ORDER BY id",
    "PRAGMA foreign_key_check",
  ];
  const snapshot = dir => query(dir, checks.join(";")).map(({ results }) => results);
  const expected = snapshot(source);
  assert.deepEqual(expected.at(-1), []);
  assert.deepEqual(snapshot(restored), expected);
  query(restored, "UPDATE members SET suspended_at = unixepoch() WHERE id = 'fixture-owner'");
  query(restored, "INSERT INTO auth_sessions VALUES ('post-restore-token','fixture-owner',unixepoch()+60)");
  assert.deepEqual(query(restored, "SELECT member_id FROM auth_sessions")[0].results, []);
  console.log("Local D1 upgrade and restore verified with fictional records.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
