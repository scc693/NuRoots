import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createTestHarness, unstable_splitSqlQuery } from "wrangler";

test("an owner can invite a relative who can join, sign in, and sign out", async t => {
  const server = createTestHarness({
    workers: [{
      configPath: "./wrangler.jsonc",
      secrets: { AUTH_RATE_SECRET: randomBytes(32).toString("hex") },
    }],
  });
  t.after(() => server.close());
  await server.listen();
  const worker = server.getWorker();
  const { DB: db } = await worker.getEnv();
  const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
  await db.batch(unstable_splitSqlQuery(schema).map(sql => db.prepare(sql)));
  await worker.applyD1Migrations("DB");

  const origin = "https://nuroots.example.test";
  function request(path, { form, cookie } = {}) {
    const headers = new Headers();
    if (form) headers.set("Origin", origin);
    if (cookie) headers.set("Cookie", cookie);
    return worker.fetch(origin + path, {
      method: form ? "POST" : "GET",
      body: form ? new URLSearchParams(form) : undefined,
      headers,
      redirect: "manual",
    });
  }

  const owner = { email: "organizer@example.test", password: "fictional organizer passphrase" };
  const ownerCode = randomBytes(32).toString("hex");
  await db.prepare(`INSERT INTO auth_invites (email, token_hash, role, expires_at)
    VALUES (?, ?, 'owner', unixepoch() + 172800)`)
    .bind(owner.email, createHash("sha256").update(ownerCode).digest("hex")).run();
  assertRedirect(await request("/join", { form: { ...owner, code: ownerCode } }), "/signin");
  const ownerCookie = assertSession(await request("/signin", { form: owner }));

  assertRedirect(await request("/account"), "/signin");
  const relative = { email: "relative@example.test", password: "fictional relative passphrase" };
  const invitation = await request("/account/invitations", {
    cookie: ownerCookie,
    form: { email: relative.email, role: "viewer" },
  });
  assert.equal(invitation.status, 201);
  const code = (await invitation.text()).match(/\/join#([a-f0-9]{64})/)?.[1];
  assert.ok(code, "the invitation page should include a join link");

  const joinForm = { ...relative, code };
  assertRedirect(await request("/join", { form: joinForm }), "/signin");
  const replay = await request("/join", { form: joinForm });
  assert.equal(replay.status, 400);
  assert.match(await replay.text(), /invalid, expired, or already used/);

  const relativeCookie = assertSession(await request("/signin", { form: relative }));
  const account = await request("/account", { cookie: relativeCookie });
  assert.equal(account.status, 200);
  const accountHtml = await account.text();
  assert.match(accountHtml, /relative@example\.test<\/strong> · viewer/);
  assert.match(accountHtml, /href="\/tree"/);

  await t.test("branch and circle membership are independent of global account role", async () => {
    const seed = await readFile(new URL("../fixtures/community-preview.sql", import.meta.url), "utf8");
    await db.batch(unstable_splitSqlQuery(seed).map(sql => db.prepare(sql)));
    await db.prepare("INSERT INTO communities(id,kind,name) VALUES ('quilters','circle','Family Quilters')").run();
    await db.prepare("INSERT INTO community_memberships SELECT 'quilters',id,'member',CURRENT_TIMESTAMP FROM members WHERE email = ?")
      .bind(relative.email).run();
    const api = "/api/communities";
    assert.equal((await request(api)).status, 401);
    assertRedirect(await request("/communities"), "/signin");
    const own = await (await request(api, { cookie: ownerCookie })).json();
    assert.deepEqual(own, { communities: [{ id: "sample-harlow", name: "Harlow family", kind: "branch", role: "steward" }], next: null });
    const joined = await request("/communities", { cookie: relativeCookie });
    assert.match(await joined.text(), /Family Quilters/);
    for (const [cookie, other] of [[ownerCookie, "quilters"], [relativeCookie, "sample-harlow"]]) {
      const denied = await request(api + "/" + other, { cookie });
      assert.equal(denied.status, 404);
      assert.deepEqual(await denied.json(), { error: "Community not found" });
    }
    const ownPath = api + "/quilters";
    assert.equal((await request(ownPath, { cookie: relativeCookie })).status, 200);
    await db.prepare("DELETE FROM community_memberships WHERE community_id = 'quilters'").run();
    assert.equal((await request(ownPath, { cookie: relativeCookie })).status, 404);
    assert.deepEqual(await (await request(api, { cookie: relativeCookie })).json(), { communities: [], next: null });
  });

  await t.test("scoped invitations require approval and recipient acceptance, expire, and cannot be replayed", async () => {
    const branch = "/communities/sample-harlow";
    const change = (form, cookie = ownerCookie) => request(branch + "/invitations", { cookie, form });
    const accept = (id, cookie = relativeCookie) => request("/community-invitations/accept", { cookie, form: { id } });
    const propose = () => change({ action: "propose", email: relative.email });
    const pending = () => db.prepare("SELECT id FROM community_invitations WHERE state = 'pending'").first("id");
    assert.equal((await change({ action: "propose", email: owner.email }, relativeCookie)).status, 404);
    const unknown = await change({ action: "propose", email: "missing@example.test" });
    assert.equal(await unknown.text(), await (await propose()).text());
    const deniedId = await pending();
    assert.equal((await accept(deniedId)).status, 404);
    assertRedirect(await change({ id: deniedId, action: "deny" }), branch);
    assert.equal((await change({ id: deniedId, action: "approve" })).status, 404);

    await propose();
    const revoked = await pending();
    assertRedirect(await change({ id: revoked, action: "approve" }), branch);
    assertRedirect(await change({ id: revoked, action: "revoke" }), branch);
    assert.equal((await accept(revoked)).status, 404);
    await propose();
    const expired = await pending();
    await db.prepare("UPDATE community_invitations SET expires_at = unixepoch()-1 WHERE id = ?").bind(expired).run();
    assert.equal((await change({ id: expired, action: "approve" })).status, 404);
    await propose();
    await propose();
    const id = await pending();
    const review = await request(branch, { cookie: ownerCookie });
    assert.match(await review.text(), /Invitation review/);
    assertRedirect(await change({ id, action: "approve" }), branch);
    assert.equal((await request(branch, { cookie: relativeCookie })).status, 404);
    assert.equal((await accept(id, ownerCookie)).status, 404);
    assert.match(await (await request("/communities", { cookie: relativeCookie })).text(), /Accept invitation/);
    const attempts = await Promise.all([accept(id), accept(id)]);
    assert.deepEqual(attempts.map(result => result.status).sort(), [303, 404]);
    const admitted = await request("/api" + branch, { cookie: relativeCookie });
    assert.equal((await admitted.json()).role, "member");
    assert.equal((await change({ action: "approve", id }, relativeCookie)).status, 403);
  });

  await t.test("stewards can revoke a branch membership without changing the family account", async () => {
    const branch = "/communities/sample-harlow";
    const members = branch + "/members";
    const roster = await request(members, { cookie: ownerCookie });
    const id = (await roster.text()).match(/name="member" value="([^"]+)"/)[1];
    const form = { member: id };
    assert.equal((await request(members, { cookie: relativeCookie, form })).status, 403);
    assertRedirect(await request(members, { cookie: ownerCookie, form }), members);
    assert.equal((await request(branch, { cookie: relativeCookie })).status, 404);
    const invitation = await db.prepare("SELECT id FROM community_invitations WHERE state = 'accepted'").first("id");
    assert.equal((await request("/community-invitations/accept", { cookie: relativeCookie, form: { id: invitation } })).status, 404);
    assert.equal((await request(branch, { cookie: relativeCookie })).status, 404);
    assert.equal((await request("/account", { cookie: relativeCookie })).status, 200);
    assert.equal((await request(members, { cookie: ownerCookie, form })).status, 404);
    const ownerId = await db.prepare("SELECT id FROM members WHERE email = ?").bind(owner.email).first("id");
    assert.equal((await request(members, { cookie: ownerCookie, form: { member: ownerId } })).status, 404);
  });

  const personPath = "/api/tree/people/fictional-deceased";
  const treePath = "/tree/people/fictional-deceased";
  const fixtures = await readFile(new URL("../fixtures/family-tree.sql", import.meta.url), "utf8");
  await db.batch(unstable_splitSqlQuery(fixtures).map(sql => db.prepare(sql)));

  await t.test("private tree data is limited to the permitted fields and records", async () => {
    const anonymous = await request(personPath);
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), { error: "Sign in required" });

    const person = await request(personPath, { cookie: relativeCookie });
    assert.equal(person.status, 200);
    assert.equal(person.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await person.json(), { id: "fictional-deceased", displayName: "Eleanor Bennett" });

    for (const id of ["fictional-living", "missing"]) {
      const hidden = await request(`/api/tree/people/${id}`, { cookie: relativeCookie });
      assert.equal(hidden.status, 404);
      assert.deepEqual(await hidden.json(), { error: "Person not found" });
    }
  });

  await t.test("members can follow parent, partner, and child links without revealing living relatives", async () => {
    assertRedirect(await request("/tree"), "/signin");
    assertRedirect(await request(treePath), "/signin");

    const index = await request("/tree", { cookie: relativeCookie });
    assert.equal(index.status, 200);
    const indexHtml = await index.text();
    assert.match(indexHtml, /Family tree preview/);
    assert.match(indexHtml, /href="\/tree\/people\/fictional-deceased">Eleanor Bennett/);
    assert.doesNotMatch(indexHtml, /fictional-living|Alex Bennett/);

    const focus = await request(treePath, { cookie: relativeCookie });
    assert.equal(focus.status, 200);
    assert.equal(focus.headers.get("Cache-Control"), "no-store");
    const focusHtml = await focus.text();
    assert.match(focusHtml, /<h1>Eleanor Bennett<\/h1>/);
    assert.match(focusHtml, /<h2>Parents<\/h2>[\s\S]*?>Rose Harlow<\/a>/);
    assert.match(focusHtml, /<h2>Partners<\/h2>[\s\S]*?>George Bennett<\/a>/);
    assert.match(focusHtml, /<h2>Children<\/h2>[\s\S]*?>Margaret Bennett<\/a>/);
    assert.doesNotMatch(focusHtml, /fictional-living|Alex Bennett|Private test biography|1938-05-24/);

    for (const id of ["fictional-parent", "fictional-partner", "fictional-child"]) {
      const path = `/tree/people/${id}`;
      assert.ok(focusHtml.includes(`href="${path}"`));
      const relative = await request(path, { cookie: relativeCookie });
      assert.equal(relative.status, 200);
      assert.match(await relative.text(), /href="\/tree\/people\/fictional-deceased">Eleanor Bennett/);
    }

    const living = await request("/tree/people/fictional-living", { cookie: relativeCookie });
    const missing = await request("/tree/people/missing", { cookie: relativeCookie });
    assert.equal(living.status, 404);
    assert.equal(missing.status, 404);
    assert.equal(await living.text(), await missing.text());
  });

  await t.test("creating a person requires editor access and explicit deceased status", async () => {
    const path = "/tree/new";
    assert.equal((await request(path, { cookie: relativeCookie })).status, 403);
    const html = await (await request(path, { cookie: ownerCookie })).text();
    const id = html.match(/name="id" value="([^"]+)"/)[1];
    const fields = { id, given: "Avery", family: "Craig" };
    const submit = form => request(path, { cookie: ownerCookie, form });
    assert.equal((await submit(fields)).status, 400);
    const form = { ...fields, deceased: "yes" };
    assertRedirect(await submit(form), "/tree/people/" + id);
    assert.equal((await submit(form)).status, 409);
    const audit = await db.prepare("SELECT action, actor_email FROM change_log WHERE entity_id = ?").bind(id).all();
    assert.deepEqual(audit.results, [{ action: "create", actor_email: owner.email }]);
  });

  await t.test("editors can correct relationships while invalid links leave no audit entry", async () => {
    const path = treePath + "/relationships";
    const add = (target, kind, id = crypto.randomUUID()) => request(path, { cookie: ownerCookie, form: { id, target, kind } });
    const target = "fictional-grandparent";
    assert.equal((await request(path, { cookie: relativeCookie, form: { target, kind: "parent" } })).status, 403);
    assert.match(await (await request(path + "?q=harlow", { cookie: ownerCookie })).text(), /Clara Harlow/);
    assert.equal((await add("fictional-deceased", "child")).status, 400);
    assert.equal((await add("fictional-living", "child")).status, 409);
    assert.equal((await add("fictional-partner", "partner")).status, 409);
    assert.equal((await add(target, "child")).status, 409);
    assertRedirect(await add(target, "parent"), treePath);
    const selection = await (await request(path + "?person=" + target, { cookie: ownerCookie })).text();
    const edge = selection.match(/name="remove" value="([^"]+)"/)[1];
    const remove = other => request(path, { cookie: ownerCookie, form: { target: other, remove: edge } });
    assert.equal((await remove("fictional-child")).status, 409);
    assertRedirect(await remove(target), treePath);
    assert.equal((await add(target, "parent", edge)).status, 409);
    assert.equal((await remove(target)).status, 409);
    const { results } = await db.prepare("SELECT entity_id, action FROM change_log WHERE entity_type = 'relationship' ORDER BY rowid").all();
    assert.deepEqual(results, [{ entity_id: edge, action: "add" }, { entity_id: edge, action: "remove" }]);
  });

  await t.test("source citations attach to one visible person and record their provenance", async () => {
    const path = treePath + "/sources";
    const html = await (await request(path, { cookie: ownerCookie })).text();
    const id = html.match(/name="id" value="([^"]+)"/)[1];
    const form = { id, title: "Fictional register", locator: "County archive, page 10" };
    assert.equal((await request(path, { cookie: relativeCookie, form })).status, 403);
    assert.equal((await request(path.replace("fictional-deceased", "fictional-living"), { cookie: ownerCookie, form })).status, 404);
    assertRedirect(await request(path, { cookie: ownerCookie, form }), path);
    assert.equal((await request(path, { cookie: ownerCookie, form })).status, 409);
    assert.match(await (await request(path, { cookie: ownerCookie })).text(), /County archive, page 10/);
    const remove = { cookie: ownerCookie, form: { remove: id } };
    assert.equal((await request(path.replace("fictional-deceased", "fictional-parent"), remove)).status, 404);
    assertRedirect(await request(path, remove), path);
    assert.equal((await request(path, { cookie: ownerCookie, form })).status, 409);
    const { results } = await db.prepare("SELECT action, actor_email FROM change_log WHERE entity_id = ? ORDER BY rowid").bind(id).all();
    assert.deepEqual(results, ["add", "remove"].map(action => ({ action, actor_email: owner.email })));
  });

  await t.test("name corrections are permission checked, versioned, audited, and reversible", async () => {
    const edit = treePath + "/edit";
    const form = { version: "0", given: "Nora", family: "Bennett" };
    assertRedirect(await request(edit, { form }), "/signin");
    assert.equal((await request(edit, { cookie: relativeCookie, form })).status, 403);
    assert.equal((await request(edit.replace("fictional-deceased", "fictional-living"), { cookie: ownerCookie, form })).status, 404);
    const blocked = await worker.fetch(origin + edit, {
      method: "POST", headers: { Cookie: ownerCookie }, body: new URLSearchParams(form),
    });
    assert.equal(blocked.status, 403);
    const asOwner = fields => request(edit, { cookie: ownerCookie, form: fields });
    assert.equal((await asOwner({ ...form, given: " " })).status, 400);
    const attempts = await Promise.all([asOwner(form), asOwner(form)]);
    assert.deepEqual(attempts.map(response => response.status).sort(), [303, 409]);
    assert.equal((await (await request(personPath, { cookie: relativeCookie })).json()).displayName, "Nora Bennett");
    const stale = await asOwner({ ...form, given: "Ellie" });
    assert.equal(stale.status, 409);
    const comparison = await stale.text();
    assert.match(comparison, /Currently saved[\s\S]*Nora Bennett/);
    assert.match(comparison, /Your entry[\s\S]*Ellie Bennett/);
    const history = await request(edit, { cookie: ownerCookie });
    assert.match(await history.text(), /Eleanor Bennett → Nora Bennett/);
    const editorId = await db.prepare("SELECT id FROM members WHERE email = ?").bind(relative.email).first("id");
    assertRedirect(await request("/account/access", { cookie: ownerCookie,
      form: { id: editorId, version: "0", action: "editor" } }), "/account/access");
    assertRedirect(await request(edit, { cookie: relativeCookie, form: { version: "1", undo: "1" } }), treePath);
    assert.equal((await (await request(personPath, { cookie: relativeCookie })).json()).displayName, "Eleanor Bennett");
    const audit = await db.prepare("SELECT actor_email FROM change_log WHERE entity_id = ? ORDER BY rowid")
      .bind("fictional-deceased").all();
    assert.deepEqual(audit.results.map(row => row.actor_email), [owner.email, relative.email]);
  });

  await t.test("the picker searches and pages visible names in stable order", async () => {
    await db.batch(Array.from({ length: 25 }, (_, i) => db.prepare(
      "INSERT INTO people(id,given_name,family_name,living) VALUES (?, 'Test', 'Relative', 0)"
    ).bind("page-" + String(i).padStart(2, "0"))));
    const search = async suffix => (await request("/tree?" + suffix, { cookie: relativeCookie })).text();
    const first = await search("q=test+rel");
    assert.match(first, /page-23/);
    assert.doesNotMatch(first, /page-24/);
    const next = first.match(/href="([^"]+)">Next page/)[1].replaceAll("&amp;", "&");
    const second = await (await request(next, { cookie: relativeCookie })).text();
    assert.match(second, /page-24/);
    assert.match(second, /Previous page/);
    assert.doesNotMatch(second, /page-23|Next page/);
    assert.match(await search("q=Alex"), /No people found/);
    assert.match(await search("q=%25"), /No people found/);
    assert.equal((await request("/tree?page=-1", { cookie: relativeCookie })).status, 400);
  });

  await t.test("large relationship lists and editor search results include later pages", async () => {
    await db.prepare(`INSERT INTO relationships(id,person1_id,person2_id,type)
      SELECT 'large-' || id,'fictional-deceased',id,'parent' FROM people WHERE id LIKE 'page-%'`).run();
    const children = await (await request(treePath + "?children=2", { cookie: relativeCookie })).text();
    assert.match(children, /page-24/);
    assert.doesNotMatch(children, /page-00/);
    assert.match(children, /Previous page/);
    const matches = await (await request(treePath + "/relationships?q=Test&page=2", { cookie: ownerCookie })).text();
    assert.match(matches, /person=page-24/);
    assert.doesNotMatch(matches, /person=page-00/);
  });

  const signOut = await request("/signout", { cookie: relativeCookie, form: {} });
  assertRedirect(signOut, "/signin");
  assert.match(signOut.headers.get("Set-Cookie") ?? "", /^__Host-nuroots_session=;.*Max-Age=0/);
  assertRedirect(await request("/account", { cookie: relativeCookie }), "/signin");
  assert.equal((await request(personPath, { cookie: relativeCookie })).status, 401);
  assertRedirect(await request(treePath, { cookie: relativeCookie }), "/signin");

  await t.test("account deactivation signs out every session and reactivation requires a fresh sign-in", async () => {
    const admin = "/account/access";
    const id = await db.prepare("SELECT id FROM members WHERE email = ?").bind(relative.email).first("id");
    const cookies = [];
    for (let i = 0; i < 2; i++) cookies.push(assertSession(await request("/signin", { form: relative })));
    const submit = (action, version, cookie = ownerCookie) => request(admin, { cookie, form: { id, action, version } });
    assert.equal((await submit("suspend", "1", cookies[0])).status, 403);
    assert.match(await (await request(admin, { cookie: ownerCookie })).text(), /relative@example.test/);
    assertRedirect(await submit("suspend", "1"), admin);
    for (const cookie of cookies) assertRedirect(await request("/account", { cookie }), "/signin");
    assert.equal((await request("/signin", { form: relative })).status, 401);
    assert.equal((await submit("restore", "1")).status, 409);
    assertRedirect(await submit("restore", "2"), admin);
    assertRedirect(await request("/account", { cookie: cookies[0] }), "/signin");
    const fresh = assertSession(await request("/signin", { form: relative }));
    assert.equal((await request(treePath + "/edit", { cookie: fresh })).status, 200);
    assertRedirect(await submit("viewer", "3"), admin);
    assert.equal((await request(treePath + "/edit", { cookie: fresh })).status, 403);
    const ownerId = await db.prepare("SELECT id FROM members WHERE email = ?").bind(owner.email).first("id");
    assert.equal((await request(admin, { cookie: ownerCookie, form: { id: ownerId, version: "0", action: "suspend" } })).status, 409);
    const audit = await db.prepare("SELECT action FROM change_log WHERE entity_id = ? AND entity_type = 'account_access' ORDER BY rowid").bind(id).all();
    assert.deepEqual(audit.results.map(row => row.action), ["editor", "suspend", "restore", "viewer"]);
  });
});

function assertRedirect(response, location) {
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), location);
}

function assertSession(response) {
  assertRedirect(response, "/account");
  const cookie = response.headers.get("Set-Cookie") ?? "";
  assert.match(cookie, /^__Host-nuroots_session=[a-f0-9]{64};.*; Secure; HttpOnly; SameSite=Lax$/);
  return cookie.split(";", 1)[0];
}
