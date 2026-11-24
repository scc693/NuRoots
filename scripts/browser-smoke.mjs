import assert from "node:assert/strict";
import axe from "axe-core";
import { chromium } from "playwright-core";
import { startPreview } from "./local-preview.mjs";

const preview = await startPreview();
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.NUROOTS_CHROME_PATH });
  async function signIn(role, width) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await context.newPage();
    await page.goto(preview.origin + "/signin");
    await accessibility(page);
    await page.getByLabel("Email address").fill(role + "@example.test");
    await page.getByLabel("Password", { exact: true }).fill(preview.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await heading(page, "Your family account");
    return page;
  }
  const inspected = new Set();
  async function accessibility(page) {
    const path = new URL(page.url()).pathname;
    if (inspected.has(path)) return;
    inspected.add(path);
    await page.evaluate(axe.source);
    const violations = await page.evaluate(async () => {
      const { violations } = await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      });
      return violations.map(rule => ({ rule: rule.id, targets: rule.nodes.map(node => node.target) }));
    });
    assert.deepEqual(violations, [], "Accessibility violations on " + path + ": " + JSON.stringify(violations));
  }

  async function heading(page, name) {
    await page.getByRole("heading", { level: 1, name, exact: true }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      "Horizontal overflow on " + name);
    await accessibility(page);
  }

  const owner = await signIn("owner", 360);
  await owner.getByRole("link", { name: "Explore the family tree preview" }).click();
  await owner.getByRole("link", { name: "Add a person" }).click();
  await accessibility(owner);
  await owner.getByLabel("Given name").fill("June");
  await owner.getByLabel("Family name").fill("North");
  await owner.getByLabel("This person is deceased.").check();
  await owner.getByRole("button", { name: "Add person" }).click();
  await heading(owner, "June North");
  await owner.getByRole("link", { name: "Edit name and view changes" }).click();
  await owner.getByLabel("Given name").fill("Judy");
  await owner.getByRole("button", { name: "Save name" }).click();
  await heading(owner, "Judy North");
  await owner.getByRole("link", { name: "Edit name and view changes" }).click();
  await owner.getByRole("button", { name: "Undo latest name change" }).click();
  await heading(owner, "June North");
  await owner.getByRole("link", { name: "Edit relationships" }).click();
  await owner.getByLabel("Find the other person").fill("Eleanor");
  await owner.getByRole("button", { name: "Search" }).click();
  await owner.getByRole("link", { name: "Eleanor Bennett" }).click();
  await owner.getByRole("button", { name: "Add relationship" }).click();
  await owner.getByRole("region", { name: "Parents" }).getByRole("link", { name: "Eleanor Bennett" }).waitFor();
  await owner.getByRole("link", { name: "Review sources" }).click();
  await accessibility(owner);
  await owner.getByLabel("Record or collection title").fill("Fictional register");
  await owner.getByLabel("Where to find it").fill("Volume 1, page 12");
  await owner.getByRole("button", { name: "Add source" }).click();
  await owner.getByText("Volume 1, page 12", { exact: true }).waitFor();

  const viewer = await signIn("viewer", 1280);
  await viewer.getByRole("link", { name: "Your branches and circles" }).click();
  const list = viewer.url();
  await owner.goto(list);
  await owner.getByRole("link", { name: "Harlow family" }).click();
  const branch = owner.url();
  await owner.getByLabel("Relative’s family account email").fill("viewer@example.test");
  await owner.getByRole("button", { name: "Request steward approval" }).click();
  await owner.getByRole("link", { name: "Back to community" }).click();
  await accessibility(owner);
  await owner.getByRole("button", { name: "Approve", exact: true }).click();
  await viewer.reload();
  await viewer.getByRole("button", { name: "Accept invitation" }).click();
  await viewer.getByRole("link", { name: "Harlow family" }).click();
  await heading(viewer, "Harlow family");
  await owner.getByRole("link", { name: "Manage members" }).click();
  await owner.getByRole("button", { name: "Remove viewer@example.test from this community" }).click();
  assert.equal((await viewer.goto(branch)).status(), 404);
  await viewer.goto(list);
  await viewer.getByRole("link", { name: "Bennett family" }).waitFor();
  await viewer.getByRole("link", { name: "Family Quilters" }).waitFor();
  assert.equal(await viewer.getByRole("link", { name: "Harlow family" }).count(), 0);
  console.log("Browser checks passed for tree editing, sources, and branch admission and removal.");
} finally {
  try {
    await browser?.close();
  } finally {
    await preview.close();
  }
}
