import { createHash, randomBytes } from "node:crypto";

const email = (process.argv[2] ?? "").trim().toLowerCase();
if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("Usage: node scripts/owner-invitation.mjs OWNER_EMAIL");
  process.exit(1);
}

const code = randomBytes(32).toString("hex");
const hash = createHash("sha256").update(code).digest("hex");
const quotedEmail = "'" + email.replaceAll("'", "''") + "'";

console.log(`INSERT INTO auth_invites (email, token_hash, role, expires_at)
SELECT ${quotedEmail}, '${hash}', 'owner', unixepoch() + 172800
WHERE NOT EXISTS (SELECT 1 FROM members WHERE role = 'owner' OR email = ${quotedEmail})
ON CONFLICT(email) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at
WHERE auth_invites.role = 'owner';`);
console.error(`Private setup link (share only with the owner): https://nuroots.clearteck.org/join#${code}`);
