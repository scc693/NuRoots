export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export const securityHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex",
};

export function page(title, content, { status = 200, error, script } = {}) {
  const nonce = script ? crypto.randomUUID() : "";

  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · NuRoots</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f5f5ef;color:#24362b;font:18px/1.5 system-ui,sans-serif}
header{background:white;border-bottom:1px solid #dbe7d8;padding:16px max(20px,calc((100% - 560px)/2))}
header a{font:bold 29px Georgia,serif;text-decoration:none;color:#214936}
header span{color:#a36825}
main{max-width:560px;margin:36px auto;padding:0 20px}
article{background:white;border:1px solid #dbe7d8;border-radius:20px;padding:clamp(20px,5vw,36px)}
h1,h2{font-family:Georgia,serif;line-height:1.1}
h1{font-size:clamp(34px,7vw,44px);margin:0 0 16px}
h2{font-size:27px;margin:28px 0 12px}
p{margin:0 0 18px}
label{display:block;font-weight:650;margin:18px 0 6px}
input,select,button{width:100%;min-height:48px;border:1px solid #7c9080;border-radius:10px;padding:10px 12px;font:inherit;color:inherit;background:white}
button{width:auto;background:#28563d;color:white;margin:20px 0 16px;padding-inline:20px;font-weight:700;cursor:pointer}
a{color:#28563d;text-underline-offset:3px}
:focus-visible{outline:3px solid #a36825;outline-offset:3px}
.help{display:block;margin-top:6px;font-size:16px;color:#4b6252}
.error{padding:12px;border:1px solid #a85235;background:#fff1e9;border-radius:10px}
.action{margin-top:16px}
</style></head><body>
<header><a href="/">Nu<span>Roots</span></a></header>
<main><article><h1>${title}</h1>${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}${content}</article></main>
${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`, {
    status,
    headers: {
      ...securityHeaders,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'${nonce ? `; script-src 'nonce-${nonce}'` : ""}`,
    },
  });
}

const emailField = (value = "") => `<label for="email">Email address</label>
<input id="email" name="email" type="email" inputmode="email" autocomplete="username" maxlength="254" value="${escapeHtml(value)}" required>`;

export function signInPage(error, status, email) {
  return page("Family sign in", `<form method="post" action="/signin">
    ${emailField(email)}
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" maxlength="512" required>
    <button>Sign in</button>
  </form>
  <p>Have an invitation? <a href="/join">Set up your account</a>.</p>
  <a href="/">Explore the sample tree</a>`, { error, status });
}

export function joinPage(error, status, { email, code = "" } = {}) {
  return page("Set up your account", `<p>Use the email address your family invited.</p>
  <form method="post" action="/join">
    ${emailField(email)}
    <label for="code">Invitation code</label>
    <input id="code" name="code" maxlength="64" spellcheck="false" autocapitalize="none" autocomplete="off" value="${escapeHtml(code)}" required>
    <label for="password">Choose a password</label>
    <input id="password" name="password" type="password" autocomplete="new-password" minlength="15" maxlength="512" aria-describedby="password-help" required>
    <small class="help" id="password-help">Use at least 15 characters. A phrase or a password manager works well.</small>
    <button>Create account</button>
  </form>
  <a href="/signin">Back to sign in</a>`, { error, status, script: `
    const code = location.hash.slice(1);
    if (/^[a-f0-9]{64}$/.test(code)) {
      document.getElementById("code").value = code;
      history.replaceState(null, "", location.pathname);
    }
  ` });
}

export function accountPage(member, error, status) {
  return page("Your family account", `<p>Signed in as <strong>${escapeHtml(member.email)}</strong> · ${escapeHtml(member.role)}</p>
  <p>The family tree is still in preview. <a href="/">Explore the sample tree</a>.</p>
  ${member.role === "owner" ? `<h2>Invite a family member</h2>
  <form method="post" action="/account/invitations">
    <label for="invite-email">Their email address</label>
    <input id="invite-email" name="email" type="email" inputmode="email" maxlength="254" required>
    <label for="role">Access level</label>
    <select id="role" name="role">
      <option value="viewer">Viewer</option><option value="editor">Editor</option>
    </select>
    <button>Create invitation link</button>
  </form>` : ""}
  <form method="post" action="/signout"><button>Sign out</button></form>`, { error, status });
}

export function invitationPage(link) {
  return page("Invitation ready", `<p>Copy this link and share it privately with your relative. It expires in 48 hours and works once.</p>
    <label for="link">Invitation link</label><input id="link" type="url" value="${escapeHtml(link)}" readonly>
    <button id="copy" type="button" hidden>Copy invitation link</button>
    <div role="status" id="copy-status"></div>
    <p class="action"><a href="/account">Back to your account</a></p>`, { status: 201, script: `
      const button = document.getElementById("copy");
      const link = document.getElementById("link");
      const status = document.getElementById("copy-status");
      button.hidden = false;
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(link.value);
          status.textContent = "Invitation link copied.";
        } catch {
          link.focus();
          link.select();
          status.textContent = "Copy the selected link.";
        }
      });
    ` });
}

export function redirect(location, cookie) {
  const headers = { ...securityHeaders, Location: location };
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(null, { status: 303, headers });
}
