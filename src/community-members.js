import { readFields } from "./auth.js";
import { escapeHtml, page, redirect } from "./auth-pages.js";

export async function manageCommunityMembers(request, db, member, group, url) {
  const back = "/communities/" + encodeURIComponent(group.id);
  const nav = `<nav><a href="${back}">${escapeHtml(group.name)}</a></nav>`;
  const fail = (error, status) => page(error, nav, { status });
  if (group.role !== "steward") return fail("Steward access required", 403);
  if (request.method === "GET") {
    const after = url.searchParams.get("after") || "";
    const { results } = await db.prepare(`SELECT m.member_id, m.role, a.email FROM community_memberships m
      JOIN members a ON a.id = m.member_id WHERE m.community_id = ? AND m.member_id > ?
      ORDER BY m.member_id LIMIT 25`).bind(group.id, after).all();
    const rows = results.slice(0, 24);
    return page("Members of " + group.name, nav + rows.map(row =>
      row.role === "steward" ? `<p>${escapeHtml(row.email)} · steward</p>` :
        `<form method="post"><input type="hidden" name="member" value="${escapeHtml(row.member_id)}">
          <button>Remove ${escapeHtml(row.email)} from this community</button></form>`).join("") +
      (results.length > 24 ? `<a href="?after=${encodeURIComponent(rows.at(-1).member_id)}">More members</a>` : ""));
  }
  if (request.headers.get("Origin") !== url.origin) return fail("Request blocked", 403);
  const fields = await readFields(request);
  const recipient = fields?.get("member");
  if (!recipient) return fail("Choose a member", 400);
  // Only the selected community membership is removed. Steward succession is separately governed.
  const filter = `community_id = ?1 AND member_id = ?2 AND role = 'member'
    AND EXISTS (SELECT 1 FROM community_memberships steward WHERE steward.community_id = ?1
      AND steward.member_id = ?3 AND steward.role = 'steward')`;
  const [, removal] = await db.batch([
    db.prepare(`INSERT INTO change_log(id,actor_email,action,entity_type,entity_id,old_value)
      SELECT ?4,?5,'remove','community_membership',community_id,json_object('member_id',member_id,'role',role)
      FROM community_memberships WHERE ${filter}`).bind(group.id, recipient, member.id, crypto.randomUUID(), member.email),
    db.prepare(`DELETE FROM community_memberships WHERE ${filter}`).bind(group.id, recipient, member.id),
  ]);
  return removal.meta.changes ? redirect(back + "/members") : fail("Membership unavailable", 404);
}
