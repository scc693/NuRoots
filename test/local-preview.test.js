import assert from "node:assert/strict";
import test from "node:test";
import { startPreview } from "../scripts/local-preview.mjs";

test("the disposable preview serves three usable fictional accounts over loopback HTTP", async t => {
  const preview = await startPreview();
  t.after(preview.close);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(preview.origin).hostname));
  for (const role of ["owner", "editor", "viewer"]) {
    const email = role + "@example.test";
    const signedIn = await fetch(preview.origin + "/signin", {
      method: "POST", redirect: "manual", headers: { Origin: preview.origin },
      body: new URLSearchParams({ email, password: preview.password }),
    });
    assert.equal(signedIn.status, 303);
    const headers = { Cookie: signedIn.headers.get("Set-Cookie").split(";", 1)[0] };
    const tree = await fetch(preview.origin + "/tree/new", { headers });
    assert.equal(tree.status, role === "viewer" ? 403 : 200);
    const branch = await fetch(preview.origin + "/api/communities/sample-harlow", { headers });
    assert.equal(branch.status, role === "owner" ? 200 : 404);
    const circle = await fetch(preview.origin + "/api/communities/sample-quilters", { headers });
    if (role === "editor") assert.equal(circle.status, 404);
    else assert.equal((await circle.json()).role, role === "viewer" ? "steward" : "member");
  }
});
