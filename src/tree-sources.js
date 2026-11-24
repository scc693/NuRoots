import { formIdPattern } from "./tree-edits.js";
import { escapeHtml, page, redirect } from "./auth-pages.js";

export async function editTreeSources(url, form, db, member, personId) {
  const back = "/tree/people/" + encodeURIComponent(personId);
  const nav = `<nav><a href="${back}">Back to person</a></nav>`;
  const fail = (message, status) => page(message, nav, { status });
  const person = await db.prepare("SELECT given_name, family_name FROM people WHERE living = 0 AND id = ?")
    .bind(personId).first();
  if (!person) return fail("Person not found", 404);
  if (!form) {
    const after = url.searchParams.get("after") || "";
    const { results } = await db.prepare(`SELECT id,title,locator FROM person_citations WHERE person_id = ?
      AND id > ? ORDER BY id LIMIT 25`).bind(personId, after).all();
    const citations = results.slice(0, 24);
    return page("Sources for " + (person.given_name + " " + person.family_name).trim(), nav +
      (citations.length ? `<ul>${citations.map(citation =>
        `<li><strong>${escapeHtml(citation.title)}</strong><p>${escapeHtml(citation.locator)}</p>
        <form method="post"><button name="remove" value="${escapeHtml(citation.id)}">Remove source <span>${escapeHtml(citation.title)}</span></button></form></li>`
      ).join("")}</ul>` : "<p>No sources on this page.</p>") +
      (results.length > 24 ? `<a href="?after=${encodeURIComponent(citations.at(-1).id)}">More sources</a>` : "") +
      `<h2>Add a source</h2><form method="post">
        <input type="hidden" name="id" value="${crypto.randomUUID()}">
        <label for="title">Record or collection title</label><input id="title" name="title" maxlength="180" required>
        <label for="locator">Where to find it</label><input id="locator" name="locator" maxlength="400"
        placeholder="Archive, year, volume and page" required>
        <button>Add source</button></form>`);
  }
  const remove = form.get("remove");
  if (remove) {
    const filter = `person_id = ?1 AND id = ?2 AND EXISTS (SELECT 1 FROM people WHERE id = ?1 AND living = 0)`;
    const [, result] = await db.batch([
      db.prepare(`INSERT INTO change_log(id, actor_email, action, entity_type, entity_id, old_value)
        SELECT ?3, ?4, 'remove','citation',id,json_object('person',person_id,'title',title,'locator',locator)
        FROM person_citations WHERE ${filter}`).bind(personId, remove, crypto.randomUUID(), member.email),
      db.prepare(`DELETE FROM person_citations WHERE ${filter}`).bind(personId, remove),
    ]);
    return result.meta.changes ? redirect(back + "/sources") : fail("Source unavailable", 404);
  }
  const title = (form.get("title") || "").trim();
  const locator = (form.get("locator") || "").trim();
  const id = form.get("id");
  if (!title || title.length > 180 || !locator || locator.length > 400 || !formIdPattern.test(id ?? "")) {
    return fail("Enter a source title and where to find it", 400);
  }
  const [insert] = await db.batch([
    db.prepare(`INSERT INTO person_citations(id,person_id,title,locator) SELECT ?,id,?,? FROM people
      WHERE id = ? AND living = 0 AND NOT EXISTS (SELECT 1 FROM change_log
        WHERE entity_type = 'citation' AND entity_id = ? AND action = 'add')
      ON CONFLICT(id) DO NOTHING`).bind(id, title, locator, personId, id),
    db.prepare(`INSERT INTO change_log(id, actor_email, action, entity_type, entity_id, new_value)
      SELECT ?, ?, 'add','citation',id,json_object('person',person_id,'title',title,'locator',locator)
      FROM person_citations WHERE id = ? AND changes() = 1`).bind(crypto.randomUUID(), member.email, id),
  ]);
  return insert.meta.changes ? redirect(back + "/sources") : fail("Source could not be added", 409);
}
