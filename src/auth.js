import { Buffer } from "node:buffer";
import { scrypt, timingSafeEqual } from "node:crypto";
import { accountPage, invitationPage, joinPage, page, redirect, signInPage } from "./auth-pages.js";

const cookieName = "__Host-nuroots_session";
const sessionSeconds = 7 * 24 * 60 * 60;
const inviteSeconds = 48 * 60 * 60;
const attemptWindow = 15 * 60;
const tokenPattern = /^[a-f0-9]{64}$/;
const routes = new Map([
  ["/signin", ["GET", "POST"]],
  ["/join", ["GET", "POST"]],
  ["/account", ["GET"]],
  ["/account/invitations", ["POST"]],
  ["/signout", ["POST"]],
]);
const encoder = new TextEncoder();

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(size) {
  return hex(crypto.getRandomValues(new Uint8Array(size)).buffer);
}

async function tokenHash(token) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
}

function derivePassword(password, salt) {
  // OWASP scrypt parameters for a 32 MiB memory configuration.
  return new Promise((resolve, reject) => {
    scrypt(password, Buffer.from(salt, "hex"), 32, { N: 32768, r: 8, p: 3, maxmem: 40 * 1024 * 1024 },
      (error, key) => error ? reject(error) : resolve(key));
  });
}

function emailAddress(fields) {
  const email = (fields.get("email") ?? "").trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function readSessionToken(request) {
  const token = request.headers.get("Cookie")?.split(";").map(part => part.trim())
    .find(part => part.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
  return tokenPattern.test(token ?? "") ? token : null;
}

function sessionCookie(token, age) {
  return `${cookieName}=${token}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Lax`;
}

async function currentMember(db, request, now) {
  const token = readSessionToken(request);
  if (!token) return null;

  return db.prepare(`SELECT members.id, members.email, members.role
    FROM auth_sessions JOIN members ON members.id = auth_sessions.member_id
    WHERE token_hash = ? AND expires_at > ?`)
    .bind(await tokenHash(token), now).first();
}

async function startSession(db, memberId, request, now) {
  const token = randomHex(32);
  const oldToken = readSessionToken(request);
  const oldHash = oldToken ? await tokenHash(oldToken) : null;
  await db.batch([
    db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ? OR token_hash = ?").bind(now, oldHash),
    db.prepare("INSERT INTO auth_sessions (token_hash, member_id, expires_at) VALUES (?, ?, ?)")
      .bind(await tokenHash(token), memberId, now + sessionSeconds),
  ]);
  return redirect("/account", sessionCookie(token, sessionSeconds));
}

async function readFields(request) {
  const type = request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded" || !request.body) return null;

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let body = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new URLSearchParams(body + decoder.decode());
    length += value.byteLength;
    if (length > 8192) {
      await reader.cancel();
      return null;
    }
    body += decoder.decode(value, { stream: true });
  }
}

async function allowAttempt(env, request, email, action, now) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(env.AUTH_RATE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const expiry = (Math.floor(now / attemptWindow) + 1) * attemptWindow;
  const buckets = await Promise.all([
    crypto.subtle.sign("HMAC", key, encoder.encode(`${action}:ip:${ip}`)),
    crypto.subtle.sign("HMAC", key, encoder.encode(`${action}:email:${email}`)),
  ]);
  const statement = env.DB.prepare(`INSERT INTO auth_attempts (bucket, expires_at, attempts)
    VALUES (?, ?, 1)
    ON CONFLICT(bucket) DO UPDATE SET expires_at = excluded.expires_at,
      attempts = CASE WHEN auth_attempts.expires_at < excluded.expires_at THEN 1 ELSE min(auth_attempts.attempts + 1, 31) END
    RETURNING attempts`);
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_attempts WHERE expires_at <= ?").bind(now),
    ...buckets.map(bucket => statement.bind(hex(bucket), expiry)),
  ]);
  return results[1].results[0].attempts <= 30 && results[2].results[0].attempts <= 8;
}

async function signIn(request, env, fields, now) {
  const email = emailAddress(fields);
  const password = fields.get("password") ?? "";
  const error = "That email or password didn’t match. Please try again.";
  if (!email || !password || password.length > 512) return signInPage(error, 400);
  if (!await allowAttempt(env, request, email, "signin", now)) {
    return signInPage("Too many attempts. Please wait up to 15 minutes and try again.", 429, email);
  }

  const member = await env.DB.prepare(`SELECT members.id, auth_passwords.password_hash
    FROM members JOIN auth_passwords ON auth_passwords.member_id = members.id WHERE email = ?`).bind(email).first();
  const stored = /^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(member?.password_hash ?? "");
  const candidate = await derivePassword(password, stored?.[1] ?? "0".repeat(32));
  const matches = timingSafeEqual(candidate, Buffer.from(stored?.[2] ?? "0".repeat(64), "hex"));
  if (!stored || !matches) return signInPage(error, 401, email);
  return startSession(env.DB, member.id, request, now);
}

async function join(request, env, fields, now) {
  const email = emailAddress(fields);
  const code = (fields.get("code") ?? "").trim();
  const password = fields.get("password") ?? "";
  const error = "This invitation is invalid, expired, or already used. Ask your family organizer for help.";
  if (!email || !tokenPattern.test(code)) return joinPage(error, 400);
  if ([...password].length < 15 || password.length > 512) {
    return joinPage("Choose a password with at least 15 characters.", 400, { email, code });
  }
  if (!await allowAttempt(env, request, email, "join", now)) {
    return joinPage("Too many attempts. Please wait up to 15 minutes and try again.", 429, { email, code });
  }

  const digest = await tokenHash(code);
  const invite = await env.DB.prepare("SELECT 1 FROM auth_invites WHERE email = ? AND token_hash = ? AND expires_at > ?")
    .bind(email, digest, now).first();
  if (!invite) return joinPage(error, 400);

  const memberId = crypto.randomUUID();
  const salt = randomHex(16);
  const hash = `scrypt-v1$${salt}$${(await derivePassword(password, salt)).toString("hex")}`;
  // Recheck the invite inside the transaction so concurrent attempts can only redeem it once.
  const [member] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO members (id, email, role)
      SELECT ?, email, role FROM auth_invites
      WHERE email = ? AND token_hash = ? AND expires_at > ?
        AND (role <> 'owner' OR NOT EXISTS (SELECT 1 FROM members WHERE role = 'owner'))
      ON CONFLICT(email) DO NOTHING`).bind(memberId, email, digest, now),
    env.DB.prepare(`INSERT INTO auth_passwords (member_id, password_hash)
      SELECT id, ? FROM members WHERE id = ?`).bind(hash, memberId),
    env.DB.prepare(`DELETE FROM auth_invites WHERE token_hash = ?
      AND EXISTS (SELECT 1 FROM members WHERE id = ?)`).bind(digest, memberId),
  ]);
  if (!member.meta.changes) return joinPage(error, 400);
  return redirect("/signin");
}

async function createInvitation(db, member, fields, now, origin) {
  const email = emailAddress(fields);
  const role = fields.get("role");
  if (!email || !["editor", "viewer"].includes(role)) {
    return accountPage(member, "Enter a valid email address and choose an access level.", 400);
  }

  const code = randomHex(32);
  const [, result] = await db.batch([
    db.prepare("DELETE FROM auth_invites WHERE expires_at <= ?").bind(now),
    db.prepare(`INSERT INTO auth_invites (email, token_hash, role, expires_at)
      SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM members WHERE email = ?)
      ON CONFLICT(email) DO UPDATE SET token_hash = excluded.token_hash,
        role = excluded.role, expires_at = excluded.expires_at`)
      .bind(email, await tokenHash(code), role, now + inviteSeconds, email),
  ]);
  if (!result.meta.changes) return accountPage(member, "That email already has a family account.", 409);
  return invitationPage(`${origin}/join#${code}`);
}

export async function handleAuth(request, env, url) {
  const path = url.pathname;
  const methods = routes.get(path);
  if (!methods) return null;
  if (!methods.includes(request.method)) {
    return new Response(null, { status: 405, headers: { Allow: methods.join(", "), "Cache-Control": "no-store" } });
  }
  if (!env.DB || !env.AUTH_RATE_SECRET) return page("Sign-in unavailable", "<p>Please try again later.</p>", { status: 503 });

  if (request.method === "POST" && request.headers.get("Origin") !== url.origin) {
    return page("Request blocked", '<a href="/signin">Return to sign in</a>', { status: 403 });
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    if (path === "/signin" && request.method === "GET") {
      return await currentMember(env.DB, request, now) ? redirect("/account") : signInPage();
    }
    if (path === "/join" && request.method === "GET") return joinPage();
    if (path === "/signout") {
      const token = readSessionToken(request);
      if (token) await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await tokenHash(token)).run();
      return redirect("/signin", sessionCookie("", 0));
    }
    if (path === "/account" || path === "/account/invitations") {
      const member = await currentMember(env.DB, request, now);
      if (!member) return redirect("/signin");
      if (path === "/account") return accountPage(member);
      if (member.role !== "owner") return accountPage(member, "Only the family organizer can create invitations.", 403);
      const fields = await readFields(request);
      return fields ? await createInvitation(env.DB, member, fields, now, url.origin)
        : accountPage(member, "Couldn’t read the invitation form. Please try again.", 400);
    }
    const fields = await readFields(request);
    if (!fields) return page("Form unavailable", '<a href="/signin">Return to sign in</a>', { status: 400 });
    return path === "/signin" ? await signIn(request, env, fields, now) : await join(request, env, fields, now);
  } catch (error) {
    console.error("NuRoots auth request failed", { path, type: error.name });
    return page("Sign-in unavailable", "<p>Please try again later.</p>", { status: 503 });
  }
}
