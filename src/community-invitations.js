import { readFields } from "./auth.js";
import { escapeHtml, page, redirect } from "./auth-pages.js";

function decisionButton(action, label) {
  return `<button name="action" value="${action}">${label}</button>`;
}

export async function communityInvitationForms(db, group, after) {
  const path = "/communities/" + encodeURIComponent(group.id) + "/invitations";
  const propose = `<h2>Propose a member</h2><form method="post" action="${path}">
    <label for="email">Relative’s family account email</label><input id="email" name="email" type="email" maxlength="254" required>
    ${decisionButton("propose", "Request steward approval")}</form>`;
  if (group.role !== "steward") return propose;
  const { results } = await db.prepare(`SELECT i.id, i.state, m.email FROM community_invitations i
    JOIN members m ON m.id = i.recipient_id WHERE i.community_id = ?
    AND i.state IN ('pending','approved') AND i.expires_at > unixepoch()
    AND i.id > ? ORDER BY i.id LIMIT 25`).bind(group.id, after).all();
  const more = results.length > 24 ? `<a href="?reviewAfter=${encodeURIComponent(results[23].id)}">More invitations to review</a>` : "";
  return propose + `<h2>Invitation review</h2>` + (results.length ? results.slice(0, 24).map(invite =>
    `<form method="post" action="${path}"><input type="hidden" name="id" value="${escapeHtml(invite.id)}">
      <p>${escapeHtml(invite.email)} · ${invite.state}</p>${invite.state === "pending"
        ? decisionButton("approve", "Approve") + decisionButton("deny", "Deny")
        : decisionButton("revoke", "Revoke invitation")}</form>`).join("") : "<p>No open invitations on this page.</p>") + more;
}

export async function incomingInvitations(db, member, after) {
  const { results } = await db.prepare(`SELECT i.id,c.name FROM community_invitations i
    JOIN communities c ON c.id = i.community_id WHERE i.recipient_id = ? AND i.state = 'approved'
    AND i.expires_at > unixepoch() AND i.id > ? ORDER BY i.id LIMIT 25`).bind(member.id, after).all();
  if (!results.length) return "";
  const more = results.length > 24 ? `<a href="?inviteAfter=${encodeURIComponent(results[23].id)}">More invitations for you</a>` : "";
  return "<h2>Invitations for you</h2>" + results.slice(0, 24).map(invite =>
    `<form method="post" action="/community-invitations/accept"><input type="hidden" name="id" value="${escapeHtml(invite.id)}">
      <p>${escapeHtml(invite.name)}</p><button>Accept invitation</button></form>`).join("") + more;
}

export async function changeCommunityInvitation(request, db, member, communityId) {
  const back = communityId ? "/communities/" + encodeURIComponent(communityId) : "/communities";
  const fail = (error, status) => page(error, `<a href="${back}">Back to communities</a>`, { status });
  if (request.headers.get("Origin") !== new URL(request.url).origin) return fail("Request blocked", 403);
  const form = await readFields(request);
  if (!form) return fail("Invalid form", 400);
  const id = form.get("id") || "";
  if (!communityId) {
    // Accepting consumes only this recipient's approved invitation, in the same batch as joining.
    const [accepted] = await db.batch([
      db.prepare(`UPDATE community_invitations SET state = 'accepted' WHERE id = ? AND recipient_id = ?
        AND state = 'approved' AND expires_at > unixepoch()`).bind(id, member.id),
      db.prepare(`INSERT INTO community_memberships(community_id, member_id, role)
        SELECT community_id, recipient_id, 'member' FROM community_invitations
        WHERE id = ? AND recipient_id = ? AND state = 'accepted' AND changes() = 1
        ON CONFLICT(community_id,member_id) DO NOTHING`).bind(id, member.id),
    ]);
    return accepted.meta.changes ? redirect(back) : fail("Invitation unavailable", 404);
  }
  const membership = await db.prepare("SELECT role FROM community_memberships WHERE community_id = ? AND member_id = ?")
    .bind(communityId, member.id).first();
  if (!membership) return fail("Community not found", 404);
  const action = form.get("action");
  if (action === "propose") {
    const email = (form.get("email") || "").trim();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Enter a valid email address", 400);
    await db.batch([
      db.prepare(`UPDATE community_invitations SET state = 'expired' WHERE community_id = ?
        AND recipient_id = (SELECT id FROM members WHERE email = ?) AND state IN ('pending','approved')
        AND expires_at <= unixepoch()`).bind(communityId, email),
      db.prepare(`INSERT INTO community_invitations(id,community_id,recipient_id,proposer_id,expires_at)
        SELECT ?1, ?2, recipient.id, ?3, unixepoch()+172800 FROM members recipient
        WHERE recipient.email = ?4 AND EXISTS (SELECT 1 FROM community_memberships WHERE community_id = ?2 AND member_id = ?3)
        AND NOT EXISTS (SELECT 1 FROM community_memberships WHERE community_id = ?2 AND member_id = recipient.id)
        ON CONFLICT DO NOTHING`).bind(crypto.randomUUID(), communityId, member.id, email),
    ]);
    return page("Request received", `<p>Eligible requests appear in the steward’s review list.</p><a href="${back}">Back to community</a>`);
  }
  if (membership.role !== "steward") return fail("Steward access required", 403);
  const decisions = new Map([["approve", "approved"], ["deny", "denied"], ["revoke", "revoked"]]);
  const state = decisions.get(action);
  if (!state) return fail("Invalid decision", 400);
  const result = await db.prepare(`UPDATE community_invitations SET state = ?, reviewer_id = ?,
    expires_at = CASE WHEN ? = 'approved' THEN unixepoch() + 172800 ELSE expires_at END
    WHERE id = ? AND community_id = ? AND state = ? AND expires_at > unixepoch()
    AND EXISTS (SELECT 1 FROM community_memberships WHERE community_id = ? AND member_id = ? AND role = 'steward')`)
    .bind(state, member.id, state, id, communityId, action === "revoke" ? "approved" : "pending", communityId, member.id).run();
  return result.meta.changes ? redirect(back) : fail("Invitation unavailable", 404);
}
