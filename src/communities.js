import { manageCommunityMembers } from "./community-members.js";
import { changeCommunityInvitation, communityInvitationForms, incomingInvitations } from "./community-invitations.js";
import { currentMember } from "./auth.js";
import { escapeHtml, page, redirect, securityHeaders } from "./auth-pages.js";

export async function handleCommunities(request, env, url) {
  if (env.COMMUNITIES_PREVIEW_ENABLED !== true) return null;
  const accept = url.pathname === "/community-invitations/accept";
  const route = /^(\/api)?\/communities(?:\/([^/]+)(\/invitations|\/members)?)?$/.exec(url.pathname);
  if (!route && !accept) return null;
  const api = Boolean(route?.[1]);
  const response = (body, status) => Response.json(body, { status, headers: securityHeaders });
  const fail = (error, status) => api ? response({ error }, status) :
    page(error, '<a href="/account">Your account</a>', { status });
  const roster = route?.[3] === "/members";
  const mutation = accept || route?.[3] === "/invitations";
  if ((mutation || roster) && api) return null;
  const method = mutation ? "POST" : "GET";
  if (request.method !== method && !(roster && request.method === "POST")) {
    return new Response(null, { status: 405, headers: { ...securityHeaders, Allow: roster ? "GET, POST" : method } });
  }

  try {
    const member = await currentMember(env.DB, request);
    if (!member) return api ? fail("Sign in required", 401) : redirect("/signin");
    if (accept) return await changeCommunityInvitation(request, env.DB, member, null);
    // Every lookup starts from this member's explicit membership, including owner accounts.
    const selection = `SELECT c.id, c.name, c.kind, m.role FROM community_memberships m
      JOIN communities c ON c.id = m.community_id WHERE m.member_id = ?`;
    if (route[2]) {
      let id;
      try { id = decodeURIComponent(route[2]); } catch { return fail("Community not found", 404); }
      if (mutation) return await changeCommunityInvitation(request, env.DB, member, id);
      const group = await env.DB.prepare(selection + " AND m.community_id = ?").bind(member.id, id).first();
      if (!group) return fail("Community not found", 404);
      if (roster) return await manageCommunityMembers(request, env.DB, member, group, url);
      return api ? response(group, 200) : page(group.name, `<p>${group.kind === "branch" ? "Family branch" : "Circle"} · ${group.role}</p>
        <a href="/communities">Your branches and circles</a>
        ${group.role === "steward" ? `<p><a href="/communities/${encodeURIComponent(id)}/members">Manage members</a></p>` : ""}
        ${await communityInvitationForms(env.DB, group, url.searchParams.get("reviewAfter") || "")}`);
    }

    const after = url.searchParams.get("after") ?? "";
    const { results } = await env.DB.prepare(selection + " AND m.community_id > ? ORDER BY m.community_id LIMIT 25")
      .bind(member.id, after).all();
    const groups = results.slice(0, 24);
    const next = results.length > groups.length ? groups.at(-1).id : null;
    if (api) return response({ communities: groups, next }, 200);
    return page("Your branches and circles", `<nav><a href="/account">Your account</a></nav>
      ${await incomingInvitations(env.DB, member, url.searchParams.get("inviteAfter") || "")}
      ${groups.length ? `<ul>${groups.map(group => `<li><a href="/communities/${encodeURIComponent(group.id)}">${escapeHtml(group.name)}</a> · ${group.kind}</li>`).join("")}</ul>` :
        "<p>No memberships on this page.</p>"}
      ${next ? `<a href="?after=${encodeURIComponent(next)}">More memberships</a>` : ""}`);
  } catch (error) {
    console.error("NuRoots community request failed", { type: error.name });
    return fail("Communities unavailable", 503);
  }
}
