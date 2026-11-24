import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";

test("the public demo works and private preview routes are closed when preview flags are absent", async () => {
  const origin = "https://nuroots.example.test";
  const demo = await worker.fetch(new Request(origin), {});
  assert.equal(demo.status, 200);
  assert.match(await demo.text(), /Explore the example tree/);
  for (const path of [
    "/account/access", "/tree", "/tree/new", "/tree/people/person", "/tree/people/person/edit", "/tree/people/person/sources",
    "/tree/people/person/relationships", "/api/tree/people/person", "/communities", "/api/communities",
    "/communities/branch/members", "/communities/branch/invitations", "/community-invitations/accept",
  ]) {
    for (const method of ["GET", "POST"]) {
      const response = await worker.fetch(new Request(origin + path, { method }), {});
      assert.equal(response.status, 404, method + " " + path);
    }
  }
});

test("community and genealogy previews can be enabled independently", async () => {
  const origin = "https://nuroots.example.test";
  const treeOnly = { TREE_PREVIEW_ENABLED: true };
  const communitiesOnly = { COMMUNITIES_PREVIEW_ENABLED: true };
  assert.equal((await worker.fetch(new Request(origin + "/communities"), treeOnly)).status, 404);
  assert.equal((await worker.fetch(new Request(origin + "/tree"), communitiesOnly)).status, 404);
});
