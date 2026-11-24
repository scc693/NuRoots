import { pageNavigation, pageNumber, pageSize, searchPeople } from "./tree-search.js";
import { editTreeSources } from "./tree-sources.js";
import { editTreeLinks } from "./tree-links.js";
import { canEditTree, createTreePerson, editTreeName } from "./tree-edits.js";
import { currentMember, readFields } from "./auth.js";
import { redirect, securityHeaders } from "./auth-pages.js";
import { treeErrorPage, treeIndexPage, treePersonPage } from "./tree-pages.js";

const relativeQueries = [
  ["Parents", `SELECT person1_id AS id FROM relationships WHERE type = 'parent' AND person2_id = ?1`],
  ["Partners", `SELECT person2_id AS id FROM relationships WHERE type = 'partner' AND person1_id = ?1
    UNION SELECT person1_id AS id FROM relationships WHERE type = 'partner' AND person2_id = ?1`],
  ["Children", `SELECT person2_id AS id FROM relationships WHERE type = 'parent' AND person1_id = ?1`],
];

function publicPerson({ id, given_name, family_name }) {
  return { id, displayName: `${given_name} ${family_name}`.trim() };
}

function json(body, status, headers = {}) {
  return Response.json(body, { status, headers: { ...securityHeaders, ...headers } });
}

export async function handleTree(request, env, url) {
  if (env.TREE_PREVIEW_ENABLED !== true) return null;
  const index = url.pathname === "/tree" || url.pathname === "/tree/";
  const create = url.pathname === "/tree/new";
  const match = /^(\/api)?\/tree\/people\/([^/]+)(\/edit|\/relationships|\/sources)?$/.exec(url.pathname);
  if (!index && !match && !create) return null;
  const api = Boolean(match?.[1]);
  const edit = create || Boolean(match?.[3]);
  if (edit && api) return null;
  if (request.method !== "GET" && !(edit && request.method === "POST")) {
    return json({ error: "Method not allowed" }, 405, { Allow: edit ? "GET, POST" : "GET" });
  }

  const fail = (message, status) => api ? json({ error: message }, status) : treeErrorPage(message, status);
  if (!env.DB) return fail("Family tree unavailable", 503);

  try {
    const member = await currentMember(env.DB, request);
    if (!member) {
      return api ? json({ error: "Sign in required" }, 401) : redirect("/signin");
    }

    if (index) {
      const query = (url.searchParams.get("q") || "").trim();
      const page = pageNumber(url.searchParams.get("page"));
      if (query.length > 180 || !page) {
        return fail("Invalid tree search", 400);
      }
      const results = await searchPeople(env.DB, query, page);
      const navigation = pageNavigation(url, "page", page, results.length > pageSize);
      return treeIndexPage(results.slice(0, pageSize).map(publicPerson), query, navigation, canEditTree(member));
    }

    let id;
    try {
      if (match) id = decodeURIComponent(match[2]);
    } catch {
      return fail("Person not found", 404);
    }

    if (edit) {
      if (!canEditTree(member)) return fail("Editor access required", 403);
      let form = null;
      if (request.method === "POST") {
        if (request.headers.get("Origin") !== url.origin) return fail("Request blocked", 403);
        form = await readFields(request);
        if (!form) return fail("Invalid form", 400);
      }
      if (create) return await createTreePerson(form, env.DB, member);
      if (match[3] === "/sources") return await editTreeSources(url, form, env.DB, member, id);
      return match[3] === "/relationships"
        ? await editTreeLinks(url, form, env.DB, member, id)
        : await editTreeName(form, env.DB, member, id);
    }

    // Keep living records private until the project defines field-level visibility.
    const person = await env.DB.prepare(`SELECT id, given_name, family_name
      FROM people WHERE id = ? AND living = 0`).bind(id).first();
    if (!person) return fail("Person not found", 404);
    if (api) return json(publicPerson(person), 200);

    // Parent edges run from person1_id to person2_id. Partner edges work in either direction.
    const pages = relativeQueries.map(([title]) => pageNumber(url.searchParams.get(title.toLowerCase())));
    if (pages.includes(null)) return fail("Invalid relatives page", 400);
    const relatives = await env.DB.batch(relativeQueries.map(([, links], index) => env.DB.prepare(`
      SELECT p.id, p.given_name, p.family_name FROM (${links}) related
      JOIN people p ON p.id = related.id WHERE p.living = 0
      ORDER BY p.given_name COLLATE NOCASE, p.family_name COLLATE NOCASE, p.id LIMIT ?2 OFFSET ?3`)
      .bind(id, pageSize + 1, (pages[index] - 1) * pageSize)));
    const groups = relatives.map(({ results }, position) => ({
      title: relativeQueries[position][0],
      people: results.slice(0, pageSize).map(publicPerson),
      navigation: pageNavigation(url, relativeQueries[position][0].toLowerCase(), pages[position], results.length > pageSize),
    }));
    return treePersonPage(publicPerson(person), groups, canEditTree(member));
  } catch (error) {
    console.error("NuRoots tree request failed", { type: error.name });
    return fail("Family tree unavailable", 503);
  }
}
