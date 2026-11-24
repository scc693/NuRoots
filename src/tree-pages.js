import { escapeHtml, page } from "./auth-pages.js";

const styles = `
body{background:#efeae0;color:#26392d}
main{margin:clamp(16px,5vw,40px) auto;padding:0 16px}
article{background:#fffdf7;border-color:#d5c8b3;box-shadow:0 6px 20px #3c2c2310;overflow-wrap:anywhere}
.tree-nav a,.people a{display:flex;align-items:center;min-height:48px}
.tree-nav{margin-bottom:12px}
.people{display:grid;gap:8px;list-style:none;padding:0;margin:0 0 12px}
.people a{padding:8px 14px;border:1px solid #a4b3a2;border-radius:12px;background:#f1f5ee;font-weight:650}
.people a:hover{background:#e4eee0}
.people-empty{color:#526759}
`;

function names(people) {
  if (people.length === 0) return '<p class="people-empty">None available in this preview.</p>';

  return `<ul class="people" role="list">${people.map(person =>
    `<li><a href="/tree/people/${encodeURIComponent(person.id)}">${escapeHtml(person.displayName)}</a></li>`
  ).join("")}</ul>`;
}

export function treeIndexPage(people, query, navigation, editable) {
  return page("Family tree preview", `
    <nav class="tree-nav" aria-label="Family tree"><a href="/account">Your account</a></nav>
    ${editable ? '<p><a href="/tree/new">Add a person</a></p>' : ""}
    <p>Choose a person to explore their relatives. This preview uses fictional records.</p>
    <form method="get" action="/tree" role="search"><label for="q">Find a person by name</label>
      <input type="search" id="q" name="q" maxlength="180" value="${escapeHtml(query)}"><button>Search</button></form>
    ${query ? '<p><a href="/tree">Show all people</a></p>' : ""}
    ${people.length ? names(people) : "<p>No people found.</p>"}
    ${navigation}`, { styles });
}

export function treePersonPage(person, groups, editable) {
  return page(person.displayName, `
    <nav class="tree-nav" aria-label="Family tree"><a href="/tree">Choose another person</a></nav>
    ${editable ? `<p><a href="/tree/people/${encodeURIComponent(person.id)}/edit">Edit name and view changes</a></p><p><a href="/tree/people/${encodeURIComponent(person.id)}/relationships">Edit relationships</a></p><p><a href="/tree/people/${encodeURIComponent(person.id)}/sources">Review sources</a></p>` : ""}
    ${groups.map(({ title, people, navigation }) => `<section aria-label="${title}">
      <h2>${title}</h2>${names(people)}${navigation}
    </section>`).join("")}`, { styles });
}

export function treeErrorPage(title, status) {
  return page(title, '<nav class="tree-nav" aria-label="Family tree"><a href="/tree">Back to the family tree preview</a></nav>', { status, styles });
}
