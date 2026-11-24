import { createHash, randomBytes } from "node:crypto";

const [, , address = "", mode, ...extra] = process.argv;
const email = address.trim().toLowerCase();
if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    (mode !== undefined && mode !== "--local") || extra.length) {
  console.error("Usage: node scripts/owner-invitation.mjs OWNER_EMAIL [--local]");
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
const origin = mode === "--local" ? "http://localhost:8787" : "https://nuroots.clearteck.org";
console.error(`Private setup link (share only with the owner): ${origin}/join#${code}`);
