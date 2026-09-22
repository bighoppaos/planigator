import { api, creditsMe } from "./api.js";

const status = document.getElementById("status");
const rows = document.getElementById("rows");
const list = document.getElementById("list");

function cell(value) {
  const td = document.createElement("td");
  td.textContent = value;
  return td;
}

function cardLabel(account) {
  if (!account.cardLast4) return "No";
  const brand = account.cardBrand ? `${account.cardBrand} ` : "";
  return `${brand}${account.cardLast4}`;
}

function render(accounts) {
  rows.replaceChildren();
  if (!accounts.length) {
    status.textContent = "No Google sign-ins yet.";
    return;
  }
  status.textContent = `${accounts.length} signed in.`;
  list.hidden = false;
  for (const account of accounts) {
    const tr = document.createElement("tr");
    tr.append(
      cell(account.name || "—"),
      cell(account.email || "—"),
      cell(String(account.used || 0)),
      cell(account.unlimited ? "Unlimited" : String(account.left ?? 0)),
      cell(cardLabel(account)),
    );
    rows.append(tr);
  }
}

try {
  const me = await creditsMe();
  if (!me.signedIn) {
    status.textContent = "Sign in on the planner with the owner Google account, then reload this page.";
  } else {
    const data = await api("/v1/admin/accounts");
    render(Array.isArray(data.accounts) ? data.accounts : []);
  }
} catch {
  status.textContent = "This list is only for the owner account. Sign in on the planner as that Google account, then reload.";
}
