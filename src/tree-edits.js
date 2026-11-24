import { escapeHtml, page, redirect } from "./auth-pages.js";

export const formIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function canEditTree(member) {
  return member.role === "editor" || member.role === "owner";
}

function validNames(given, family) {
  return typeof given === "string" && typeof family === "string" && given.trim().length > 0
    && given.length <= 90 && family.length <= 90;
}

function nameInputs(given, family) {
  return `<label for="given">Given name</label><input id="given" name="given" value="${escapeHtml(given)}" required maxlength="90">
      <label for="family">Family name</label><input id="family" name="family" value="${escapeHtml(family)}" maxlength="90">`;
}

export async function createTreePerson(form, db, member) {
  const given = form?.get("given") ?? "";
  const family = form?.get("family") ?? "";
  const id = form?.get("id") ?? crypto.randomUUID();
  const confirmation = form?.get("deceased") === "yes";
  if (!form || !validNames(given, family) || !confirmation) {
    return page("Add a person", `<nav><a href="/tree">Back to people</a></nav>
      <p>Use a fictional deceased person for this preview. Search the tree first to avoid creating a duplicate.</p>
      <form method="post"><input type="hidden" name="id" value="${escapeHtml(id)}">${nameInputs(given, family)}
        <label><input type="checkbox" name="deceased" value="yes" required ${confirmation ? "checked" : ""}>
        This person is deceased.</label><button>Add person</button></form>`, {
      error: form ? "Enter a given name, keep each name within 90 characters and confirm the person is deceased." : undefined,
      status: form ? 400 : 200,
      styles: 'input[type="checkbox"]{width:20px;min-height:20px;vertical-align:middle}',
    });
  }
  if (!formIdPattern.test(id)) {
    return page("Invalid form", '<a href="/tree/new">Start again</a>', { status: 400 });
  }
  // The same form can only create one person and one creation entry, including on retry.
  const [insert] = await db.batch([
    db.prepare(`INSERT INTO people(id, given_name, family_name, living) VALUES (?, ?, ?, 0)
      ON CONFLICT(id) DO NOTHING`).bind(id, given.trim(), family.trim()),
    db.prepare(`INSERT INTO change_log(id, actor_email, action, entity_type, entity_id, new_value)
      SELECT ?, ?, 'create', 'person', id, json_object('given', given_name, 'family', family_name)
      FROM people WHERE id = ? AND changes() = 1`).bind(crypto.randomUUID(), member.email, id),
  ]);
  if (!insert.meta.changes) return page("This form has already been used", '<a href="/tree">Return to people</a>', { status: 409 });
  return redirect("/tree/people/" + id);
}

function editPage(person, history, error, status = 200) {
  const path = "/tree/people/" + encodeURIComponent(person.id);
  const version = `<input type="hidden" name="version" value="${person.name_version}">`;
  return page("Edit name", `
    <nav><a href="${path}">Back to person</a></nav>
    <form method="post">${version}
      ${nameInputs(person.given_name, person.family_name)}
      <button>Save name</button>
    </form>
    ${history.length ? `<h2>Recent name changes</h2><ol>${history.map(entry => {
      const before = JSON.parse(entry.old_value);
      const after = JSON.parse(entry.new_value);
      return `<li>${escapeHtml(before.given + " " + before.family)} → ${escapeHtml(after.given + " " + after.family)}</li>`;
    }).join("")}</ol><form method="post">${version}<button name="undo" value="1">Undo latest name change</button></form>` : ""}
  `, { error, status });
}

export async function editTreeName(form, db, member, id) {
  const failure = (title, status) => page(title, '<a href="/tree">Family tree</a>', { status });
  const person = await db.prepare("SELECT id, given_name, family_name, name_version FROM people WHERE id = ? AND living = 0").bind(id).first();
  if (!person) return failure("Person not found", 404);
  const { results: history } = await db.prepare(`SELECT old_value, new_value FROM change_log
    WHERE entity_id = ? AND entity_type = 'person' AND action = 'rename' ORDER BY rowid DESC LIMIT 10`).bind(id).all();
  if (!form) return editPage(person, history);
  const conflict = async () => {
    const latest = await db.prepare("SELECT given_name, family_name FROM people WHERE id = ? AND living = 0").bind(id).first();
    if (!latest) return failure("Person not found", 404);
    const given = form.get("given");
    const family = form.get("family");
    return page("Review the latest name", `<p>Someone saved a change while this form was open.</p>
      <p><strong>Currently saved</strong><br>${escapeHtml(latest.given_name + " " + latest.family_name)}</p>
      ${validNames(given, family) ? `<p><strong>Your entry</strong><br>${escapeHtml(given + " " + family)}</p>` : ""}
      <a href="/tree/people/${encodeURIComponent(id)}/edit">Open the current record</a>`, { status: 409 });
  };
  if (form.get("version") !== String(person.name_version)) return await conflict();
  let given = form.get("given");
  let family = form.get("family");
  if (form.get("undo") === "1") {
    if (!history.length) return await conflict();
    ({ given, family } = JSON.parse(history[0].old_value));
  } else {
    if (!validNames(given, family)) {
      return editPage(person, history, "Enter a given name and use at most 90 characters per field.", 400);
    }
    given = given.trim();
    family = family.trim();
  }
  const back = () => redirect("/tree/people/" + encodeURIComponent(id));
  if (given === person.given_name && family === person.family_name) return back();
  // D1 runs the batch transactionally. Both statements require the same visible revision.
  const [, update] = await db.batch([
    db.prepare(`INSERT INTO change_log (id, actor_email, action, entity_type, entity_id, old_value, new_value)
      SELECT ?, ?, 'rename', 'person', id, json_object('given', given_name, 'family', family_name),
      json_object('given', ?, 'family', ?) FROM people WHERE id = ? AND living = 0 AND name_version = ?`)
      .bind(crypto.randomUUID(), member.email, given, family, id, person.name_version),
    db.prepare(`UPDATE people SET given_name = ?, family_name = ?, name_version = name_version + 1,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND living = 0 AND name_version = ?`)
      .bind(given, family, id, person.name_version),
  ]);
  return update.meta.changes ? back() : conflict();
}
