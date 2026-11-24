import { escapeHtml } from "./auth-pages.js";

export const pageSize = 24;

export function pageNumber(value) {
  const number = Number(value ?? 1);
  return Number.isSafeInteger(number) && number >= 1 && Number.isSafeInteger(number * pageSize) ? number : null;
}

export function pageNavigation(url, parameter, current, more) {
  const link = number => {
    const params = new URLSearchParams(url.searchParams);
    params.set(parameter, String(number));
    return escapeHtml(url.pathname + "?" + params.toString());
  };
  if (current === 1 && !more) return "";
  return `<nav class="tree-nav" aria-label="${escapeHtml(parameter === "page" ? "Search pages" : parameter + " pages")}">
    ${current > 1 ? `<a href="${link(current - 1)}">Previous page</a>` : ""}
    ${more ? `<a href="${link(current + 1)}">Next page</a>` : ""}
  </nav>`;
}

export async function searchPeople(db, query, current, except = null) {
  const conditions = ["living = 0"];
  const params = [];
  if (query) {
    conditions.push("instr(lower(given_name || ' ' || family_name), lower(?)) > 0");
    params.push(query);
  }
  if (except !== null) {
    conditions.push("id <> ?");
    params.push(except);
  }
  const { results } = await db.prepare(`SELECT id,given_name,family_name FROM people
    WHERE ${conditions.join(" AND ")} ORDER BY given_name COLLATE NOCASE,family_name COLLATE NOCASE,id
    LIMIT ? OFFSET ?`).bind(...params, pageSize + 1, (current - 1) * pageSize).all();
  return results;
}
