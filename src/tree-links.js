import { formIdPattern } from "./tree-edits.js";
import { pageNavigation, pageNumber, pageSize, searchPeople } from "./tree-search.js";
import { escapeHtml, page, redirect } from "./auth-pages.js";

const visiblePerson = "SELECT id, given_name, family_name FROM people WHERE living = 0 AND id = ?";
const name = person => escapeHtml(person.given_name + " " + person.family_name);

export async function editTreeLinks(url, form, db, member, id) {
  const personPath = "/tree/people/" + encodeURIComponent(id);
  const back = `<nav><a href="${personPath}">Back to person</a></nav>`;
  const fail = (message, status) => page(message, back, { status });
  const person = await db.prepare(visiblePerson).bind(id).first();
  if (!person) return fail("Person not found", 404);

  if (!form) {
    const query = (url.searchParams.get("q") || "").trim();
    if (query.length > 180) return fail("Invalid search", 400);
    const targetId = url.searchParams.get("person");
    if (targetId) {
      const target = await db.prepare(visiblePerson).bind(targetId).first();
      if (!target || targetId === id) return fail("Person unavailable", 404);
      const { results: links } = await db.prepare(`SELECT id, type, person1_id FROM relationships
        WHERE (person1_id = ?1 AND person2_id = ?2) OR (person1_id = ?2 AND person2_id = ?1)`)
        .bind(id, targetId).all();
      const removalForms = links.map(link => {
        const label = link.type === "partner" ? "partner" : link.person1_id === id ? "child" : "parent";
        return `<form method="post"><input type="hidden" name="target" value="${escapeHtml(targetId)}">
          <p>${name(target)} is recorded as ${name(person)}’s ${label}.</p>
          <button name="remove" value="${escapeHtml(link.id)}">Remove this ${label} link</button></form>`;
      }).join("");
      return page("Edit relationships", back + `<form method="post">
        <input type="hidden" name="target" value="${escapeHtml(targetId)}">
        <input type="hidden" name="id" value="${crypto.randomUUID()}">
        <label for="kind">${name(target)} is ${name(person)}’s</label>
        <select id="kind" name="kind"><option value="parent">Parent</option>
        <option value="child">Child</option><option value="partner">Partner</option></select>
        <button>Add relationship</button></form>` + removalForms);
    }
    const current = pageNumber(url.searchParams.get("page"));
    if (!current) return fail("Invalid search page", 400);
    const matches = query ? await searchPeople(db, query, current, id) : [];
    return page("Edit relationships for " + (person.given_name + " " + person.family_name).trim(), back + `
      <form method="get"><label for="q">Find the other person</label><input type="search" id="q" name="q"
      required maxlength="180" value="${escapeHtml(query)}"><button>Search</button></form>
      ${query && !matches.length ? "<p>No people found.</p>" : ""}
      <ul>${matches.slice(0, pageSize).map(other => `<li><a href="?person=${encodeURIComponent(other.id)}">${name(other)}</a></li>`).join("")}</ul>
      ${pageNavigation(url, "page", current, matches.length > pageSize)}`);
  }

  const target = form.get("target");
  const remove = form.get("remove");
  if (typeof remove === "string" && typeof target === "string") {
    // The same selection guards both the audit record and its deletion.
    const filter = `id = ?1 AND ((person1_id = ?2 AND person2_id = ?3) OR
      (person1_id = ?3 AND person2_id = ?2)) AND
      (SELECT count(*) FROM people WHERE living = 0 AND id IN (?2, ?3)) = 2`;
    const [, deletion] = await db.batch([
      db.prepare(`INSERT INTO change_log(id, actor_email, action, entity_type, entity_id, old_value)
        SELECT ?4, ?5, 'remove', 'relationship', id, json_object('type', type, 'first', person1_id, 'second', person2_id)
        FROM relationships WHERE ${filter}`).bind(remove, id, target, crypto.randomUUID(), member.email),
      db.prepare(`DELETE FROM relationships WHERE ${filter}`).bind(remove, id, target),
    ]);
    return deletion.meta.changes ? redirect(personPath) : fail("Relationship unavailable", 409);
  }
  const kind = form.get("kind");
  if (typeof target !== "string" || !["parent", "partner", "child"].includes(kind) || id === target) {
    return fail("Choose two different people and a relationship", 400);
  }
  const type = kind === "child" ? "parent" : kind;
  const [first, second] = kind === "parent" ? [target, id] : [id, target];
  const edge = form.get("id");
  if (!formIdPattern.test(edge ?? "")) return fail("Reopen the relationship form", 400);
  // Only visible endpoints can be linked. Traverse all parent edges to prevent cycles.
  // UNION also terminates on cycles in legacy data.
  const [insert] = await db.batch([
    db.prepare(`INSERT INTO relationships(id, person1_id, person2_id, type)
      SELECT ?1, ?2, ?3, ?4 WHERE (SELECT count(*) FROM people WHERE living = 0 AND id IN (?2, ?3)) = 2
      AND NOT EXISTS (SELECT 1 FROM change_log WHERE entity_type = 'relationship' AND entity_id = ?1 AND action = 'add')
      AND NOT EXISTS (SELECT 1 FROM relationships WHERE type = ?4 AND
        ((person1_id = ?2 AND person2_id = ?3) OR (?4 = 'partner' AND person1_id = ?3 AND person2_id = ?2)))
      AND (?4 <> 'parent' OR NOT EXISTS (
        WITH RECURSIVE descendants(id) AS (SELECT ?3 UNION SELECT r.person2_id FROM relationships r
          JOIN descendants d ON r.person1_id = d.id WHERE r.type = 'parent')
        SELECT 1 FROM descendants WHERE id = ?2))`).bind(edge, first, second, type),
    db.prepare(`INSERT INTO change_log(id, actor_email, action, entity_type, entity_id, new_value)
      SELECT ?, ?, 'add', 'relationship', id, json_object('type', type, 'first', person1_id, 'second', person2_id)
      FROM relationships WHERE id = ? AND changes() = 1`).bind(crypto.randomUUID(), member.email, edge),
  ]);
  if (!insert.meta.changes) return fail("Relationship could not be added", 409);
  return redirect(personPath);
}
