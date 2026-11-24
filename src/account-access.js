import { currentMember, readFields } from "./auth.js";
import { escapeHtml, page, redirect, securityHeaders } from "./auth-pages.js";

const path = "/account/access";
const back = '<a href="/account/access">Back to family access</a>';

function memberForm(member) {
  const hidden = `<input type="hidden" name="id" value="${escapeHtml(member.id)}">
    <input type="hidden" name="version" value="${member.access_version}">`;
  return `<section><h2>${escapeHtml(member.email)}</h2>
    <p>${member.suspended_at === null ? "Active" : "Deactivated"} · ${member.role}</p>
    <form method="post">${hidden}
    ${member.suspended_at !== null ? '<button name="action" value="restore">Reactivate account</button>' :
      `<button name="action" value="${member.role === "viewer" ? "editor" : "viewer"}">Change to ${member.role === "viewer" ? "editor" : "viewer"}</button>
      <button name="action" value="suspend">Deactivate account</button>`}
    </form></section>`;
}

export async function handleAccountAccess(request, env, url) {
  if (env.ACCOUNT_ADMIN_PREVIEW_ENABLED !== true || url.pathname !== path) return null;
  const fail = (message, status) => page(message, '<a href="/account">Your account</a>', { status });
  if (!["GET", "POST"].includes(request.method)) {
    return new Response(null, { status: 405, headers: { ...securityHeaders, Allow: "GET, POST" } });
  }
  try {
    const owner = await currentMember(env.DB, request);
    if (!owner) return redirect("/signin");
    if (owner.role !== "owner") return fail("Organizer access required", 403);
    if (request.method === "GET") {
      const after = url.searchParams.get("after") || "";
      const { results } = await env.DB.prepare(`SELECT id,email,role,suspended_at,access_version
        FROM members WHERE role <> 'owner' AND id > ? ORDER BY id LIMIT 25`).bind(after).all();
      const rows = results.slice(0, 24);
      return page("Family account access", `<nav><a href="/account">Your account</a></nav>
        <p>Deactivating a relative signs them out of all sessions. Reactivating restores their existing role and memberships.</p>
        ${rows.length ? rows.map(memberForm).join("") : "<p>No family accounts on this page.</p>"}
        ${results.length > 24 ? `<a href="?after=${encodeURIComponent(rows.at(-1).id)}">More accounts</a>` : ""}`);
    }
    if (request.headers.get("Origin") !== url.origin) return fail("Request blocked", 403);
    const form = await readFields(request);
    const id = form?.get("id");
    const version = form?.get("version");
    const action = form?.get("action");
    if (!id || !/^\d+$/.test(version ?? "") || !["suspend", "restore", "viewer", "editor"].includes(action)) {
      return fail("Invalid account change", 400);
    }
    // Both statements have the same conditions so stale or repeated actions have no side effects.
    const filter = `id = ?1 AND role <> 'owner' AND access_version = ?2
      AND CASE ?3 WHEN 'restore' THEN suspended_at IS NOT NULL WHEN 'suspend' THEN suspended_at IS NULL
      ELSE suspended_at IS NULL AND role <> ?3 END`;
    const role = "CASE WHEN ?3 IN ('viewer','editor') THEN ?3 ELSE role END";
    const suspended = "CASE ?3 WHEN 'suspend' THEN unixepoch() WHEN 'restore' THEN NULL ELSE suspended_at END";
    const [, updated] = await env.DB.batch([
      env.DB.prepare(`INSERT INTO change_log(id,actor_email,action,entity_type,entity_id,old_value,new_value)
        SELECT ?4,?5,?3,'account_access',id,json_object('role',role,'suspended_at',suspended_at),
        json_object('role',${role},'suspended_at',${suspended}) FROM members WHERE ${filter}`)
        .bind(id, version, action, crypto.randomUUID(), owner.email),
      env.DB.prepare(`UPDATE members SET role = ${role}, suspended_at = ${suspended},
        access_version = access_version+1 WHERE ${filter}`).bind(id, version, action),
    ]);
    return updated.meta.changes ? redirect(path) : page("Account change unavailable", back, { status: 409 });
  } catch (error) {
    console.error("NuRoots account access request failed", { type: error.name });
    return fail("Family access unavailable", 503);
  }
}
