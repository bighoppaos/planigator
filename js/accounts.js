import { api, creditsMe, pulseActivity } from "./api.js";

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

function person(account) {
  if (account.name && account.email) return `${account.name} (${account.email})`;
  return account.email || account.name || "Someone";
}

function loggedInLabel(account) {
  if (!account.loggedIn) return "No";
  if (Number(account.browsers) > 1) return `Yes · ${account.browsers} browsers`;
  return "Yes";
}

function render(accounts) {
  rows.replaceChildren();
  const online = accounts.filter((account) => account.loggedIn);
  if (!accounts.length) {
    status.textContent = "No Google sign-ins yet.";
    return;
  }
  status.textContent = online.length
    ? `${online.length} logged in now: ${online.map(person).join(", ")}. ${accounts.length} signed up.`
    : `${accounts.length} signed up. Nobody is logged in right now.`;
  list.hidden = false;
  for (const account of accounts) {
    const tr = document.createElement("tr");
    tr.append(
      cell(account.name || "—"),
      cell(account.email || "—"),
      cell(String(account.used || 0)),
      cell(account.unlimited ? "Unlimited" : String(account.left ?? 0)),
      cell(cardLabel(account)),
      cell(loggedInLabel(account)),
    );
    rows.append(tr);
  }
}

let pulsed = false;

async function load() {
  const me = await creditsMe();
  if (me.idle || !me.signedIn) {
    list.hidden = true;
    status.textContent = me.idle
      ? "Signed out after an hour away. Sign in on the planner with the owner Google account, then reload this page."
      : "Sign in on the planner with the owner Google account, then reload this page.";
    return;
  }
  if (!pulsed) {
    pulsed = true;
    pulseActivity();
  }
  const data = await api("/v1/admin/accounts");
  render(Array.isArray(data.accounts) ? data.accounts : []);
}

try {
  await load();
  setInterval(load, 30000);
  const mark = () => pulseActivity();
  document.addEventListener("pointerdown", mark);
  document.addEventListener("keydown", mark);
} catch {
  status.textContent = "This list is only for the owner account. Sign in on the planner as that Google account, then reload.";
}
