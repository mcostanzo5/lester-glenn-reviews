"use strict";

const state = { me: null, view: "inbox", rooftop: "", filters: { status: "", stars: "", q: "" }, page: 0, rows: [], selected: null, statsDays: 90 };

const STATUS = {
  new: ["Waiting for draft", ""],
  pending: ["Needs review", "pending"],
  ready: ["Ready to auto-post", "ready"],
  approved: ["Approved, posts when live", "approved"],
  auto_posted: ["Auto-posted", "posted"],
  approved_posted: ["Posted by manager", "posted"],
  replied_external: ["Replied in Google", "posted"],
  dismissed: ["Dismissed", ""],
  old_unanswered: ["Unanswered, older", ""],
  error: ["Post failed", "error"],
};
const ANSWERED = ["auto_posted", "approved_posted", "replied_external"];

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
  const init = { method: opts.method || "GET", headers: {} };
  if (init.method !== "GET") {
    init.headers["content-type"] = "application/json";
    init.headers["x-requested-with"] = "reviews-app";
    init.body = JSON.stringify(opts.body || {});
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({ error: `The server returned an unexpected response (${res.status}).` }));
  if (res.status === 401) {
    // Session expired: send them back through Microsoft sign-in, then return here
    location.href = `/auth/login?returnTo=${encodeURIComponent(location.pathname)}`;
    throw new Error("Signing you in again\u2026");
  }
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; e.data = data; throw e; }
  return data;
}

function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (bad ? " bad" : "");
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), bad ? 6000 : 3000);
}

function stars(n, cls = "stars") {
  if (!n) return `<span class="${cls}" aria-label="No rating">No rating</span>`;
  return `<span class="${cls}" aria-label="${n} out of 5 stars">${"\u2605".repeat(n)}<span class="off">${"\u2605".repeat(5 - n)}</span></span>`;
}

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  const h = ms / 3600000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))} min ago`;
  if (h < 24) return `${Math.round(h)} hr ago`;
  const d = Math.round(h / 24);
  if (d < 45) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function hoursLabel(h) {
  if (h == null) return "\u2013";
  if (h < 48) return `${Math.round(h)}<small>hr</small>`;
  return `${(h / 24).toFixed(1)}<small>days</small>`;
}

function pill(status, isSample) {
  const [label, cls] = STATUS[status] || [status, ""];
  return `<span class="pill ${cls}">${esc(label)}</span>${isSample ? ' <span class="pill sample">Sample</span>' : ""}`;
}

function storeName(key) {
  return state.me.rooftops.find((r) => r.key === key)?.name || key;
}
const shortName = (key) => storeName(key).replace(/^Lester Glenn /, "");

/* ---------- Shell ---------- */

async function boot() {
  try {
    state.me = await api("/api/me");
  } catch (e) {
    document.body.innerHTML = `<div class="gate"><h1>Can't open the dashboard</h1><p>${esc(e.message)}</p><p><a href="/auth/logout">Sign out</a></p></div>`;
    return;
  }
  const m = state.me;
  $("#who").textContent = m.email;
  const chip = $("#modeChip");
  chip.hidden = false;
  chip.textContent = { dry_run: "Dry run", shadow: "Shadow mode", live: "Live" }[m.mode];
  chip.classList.toggle("live", m.mode === "live");
  const banner = $("#banner");
  if (m.mode === "dry_run") { banner.hidden = false; banner.textContent = "Dry run: showing sample reviews. Nothing is read from or posted to Google."; }
  if (m.mode === "shadow") { banner.hidden = false; banner.textContent = "Shadow mode: these are real reviews, but no replies are posted to Google yet."; }
  $("#settingsTab").hidden = m.role !== "admin";

  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (b) setView(b.dataset.view);
  });
  $("#storeSelect").addEventListener("change", (e) => setRooftop(e.target.value));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.selected) closeDetail(); });
  renderRail();
  setView("inbox");
  const linked = new URLSearchParams(location.search).get("review");
  if (linked) { openDetail(linked); history.replaceState(null, "", "/"); }
}

function renderRail() {
  const m = state.me;
  $("#escTab").hidden = m.escalations === null || m.escalations === undefined;
  $("#escCount").textContent = m.escalations ? String(m.escalations) : "";
  const total = m.rooftops.reduce((a, r) => a + r.open, 0);
  const btn = (key, name, town, n) => `<button data-key="${esc(key)}" aria-current="${state.rooftop === key}">
      <span class="name">${esc(name)}${town ? `<span class="town">${esc(town)}</span>` : ""}</span>
      <span class="count${n ? "" : " zero"}" aria-label="${n} in inbox">${n}</span></button>`;
  const stores = m.rooftops.filter((r) => r.key !== "other" || r.open);
  $("#rail").innerHTML = (stores.length > 1 ? `<div class="group">${btn("", "All stores", "", total)}</div>` : "") +
    stores.map((r) => btn(r.key, r.name.replace(/^Lester Glenn /, ""), r.town, r.open)).join("");
  $("#rail").onclick = (e) => { const b = e.target.closest("button[data-key]"); if (b) setRooftop(b.dataset.key); };
  $("#storeSelect").innerHTML = (stores.length > 1 ? `<option value="">All stores (${total} in inbox)</option>` : "") +
    stores.map((r) => `<option value="${esc(r.key)}" ${state.rooftop === r.key ? "selected" : ""}>${esc(r.name)} (${r.open})</option>`).join("");
}

async function refreshCounts() {
  try { state.me = await api("/api/me"); renderRail(); } catch { /* keep old counts */ }
}

function setRooftop(key) {
  state.rooftop = key;
  renderRail();
  setView(state.view);
}

function setView(view) {
  state.view = view;
  state.page = 0;
  document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
  if (view === "stats") return renderStats();
  if (view === "settings") return renderSettings();
  loadList();
}

/* ---------- Review lists ---------- */

async function loadList(append = false) {
  const q = new URLSearchParams({ view: state.view, page: String(state.page) });
  if (state.rooftop) q.set("rooftop", state.rooftop);
  if (state.view === "all") for (const [k, v] of Object.entries(state.filters)) if (v) q.set(k, v);
  const v = $("#view");
  if (!append) v.innerHTML = filtersHtml() + `<div class="empty-state">Loading reviews\u2026</div>`;
  bindFilters();
  try {
    const data = await api(`/api/reviews?${q}`);
    state.rows = append ? state.rows.concat(data.reviews) : data.reviews;
    renderList(data.more);
  } catch (e) {
    v.innerHTML = filtersHtml() + `<div class="empty-state"><strong>Reviews didn't load</strong>${esc(e.message)}</div>`;
    bindFilters();
  }
}

function filtersHtml() {
  if (state.view !== "all") return "";
  const f = state.filters;
  const opt = (val, label, cur) => `<option value="${val}" ${cur === val ? "selected" : ""}>${label}</option>`;
  return `<form class="filters" id="filters" role="search" onsubmit="return false">
    <label class="sr" for="fStatus">Status</label>
    <select id="fStatus">${opt("", "Any status", f.status)}${opt("open", "Not answered", f.status)}${opt("answered", "Answered", f.status)}
      ${opt("pending", "Needs review", f.status)}${opt("dismissed", "Dismissed", f.status)}${opt("old_unanswered", "Unanswered, older", f.status)}</select>
    <label class="sr" for="fStars">Rating</label>
    <select id="fStars">${opt("", "Any rating", f.stars)}${opt("low", "3 stars or less", f.stars)}${opt("high", "4 and 5 stars", f.stars)}</select>
    <label class="sr" for="fQ">Search</label>
    <input type="search" id="fQ" placeholder="Search review and reply text" value="${esc(f.q)}">
  </form>`;
}

function bindFilters() {
  const form = $("#filters");
  if (!form) return;
  const apply = () => {
    state.filters = { status: $("#fStatus").value, stars: $("#fStars").value, q: $("#fQ").value.trim() };
    state.page = 0;
    loadList();
  };
  $("#fStatus").onchange = apply;
  $("#fStars").onchange = apply;
  let t;
  $("#fQ").oninput = () => { clearTimeout(t); t = setTimeout(apply, 350); };
}

function renderList(more) {
  const v = $("#view");
  if (!state.rows.length) {
    const msg = state.view === "escalations"
      ? `<strong>No open escalations</strong>Reviews that have been emailed to a store team show up here until someone marks them resolved.`
      : state.view === "inbox"
      ? `<strong>Inbox is clear</strong>New reviews that need a manager will show up here.${state.me.mode === "dry_run" && state.me.role === "admin" ? " Load sample data from Settings to try it out." : ""}`
      : `<strong>No reviews match</strong>Try a different filter or store.`;
    v.innerHTML = filtersHtml() + `<div class="empty-state">${msg}</div>`;
    bindFilters();
    return;
  }
  v.innerHTML = filtersHtml() + `<div class="list">${state.rows.map(rowHtml).join("")}</div>` +
    (more ? `<button class="btn more" id="more">Show more</button>` : "");
  bindFilters();
  v.querySelector(".list").onclick = (e) => {
    const done = e.target.closest("[data-resolve]");
    if (done) return resolveFromList(done.dataset.resolve, done);
    const q = e.target.closest("[data-esc]");
    if (q) return openDetail(q.dataset.esc, true);
    const b = e.target.closest(".row");
    if (b) openDetail(b.dataset.id);
  };
  if (more) $("#more").onclick = () => { state.page++; loadList(true); };
  // Keep focus in the search box while typing
  const q = $("#fQ");
  if (q && document.activeElement !== q && state.filters.q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}

function rowHtml(r) {
  const text = r.text ? esc(r.text) : "Rating only, no written review";
  const escView = state.view === "escalations";
  const resolveBtn = escView && state.me.role !== "viewer"
    ? `<button class="esc-resolve" data-resolve="${esc(r.id)}" title="The team responded: remove from Escalations">Resolved</button>` : "";
  const quick = state.me.role !== "viewer"
    ? `<button class="esc-quick" data-esc="${esc(r.id)}" aria-label="Escalate this review" title="${r.escalation_open ? "Follow up with the team" : "Escalate"}">!</button>` : "";
  const followups = (r.escalation_open || 0) - 1;
  const when = escView
    ? `<span class="when-line">First sent ${ago(r.escalation_first_at)}</span><span class="when-line">${r.escalation_count} ${r.escalation_count === 1 ? "email" : "emails"}, last ${ago(r.escalation_last_at)}</span>${followups > 0 ? `<span class="when-line late">${followups} follow-up${followups === 1 ? "" : "s"}, no response</span>` : ""}`
    : `${ago(r.create_time)}<br>${pill(r.status, r.is_sample)}${r.escalation_count ? ` <span class="pill esc" title="Emails sent to the team about this review">\u2709 ${r.escalation_count}</span>` : ""}`;
  return `<div class="row-wrap${quick ? " has-quick" : ""}${resolveBtn ? " has-resolve" : ""}"><button class="row" data-id="${esc(r.id)}" aria-current="${state.selected === r.id}">
    <div class="stars-col">${stars(r.stars)}</div>
    <div><div class="store">${esc(shortName(r.rooftop_key))}</div><div class="excerpt${r.text ? "" : " empty"}">${text}</div></div>
    <div class="when">${when}</div>
  </button>${resolveBtn}${quick}</div>`;
}

/* ---------- Detail ---------- */

async function openDetail(id, escalate = false) {
  state.selected = id;
  document.querySelectorAll(".row").forEach((b) => b.setAttribute("aria-current", String(b.dataset.id === id)));
  const d = $("#detail");
  d.hidden = false;
  document.querySelector(".shell").classList.add("with-detail");
  d.innerHTML = `<p class="meta">Loading\u2026</p>`;
  try {
    const data = await api(`/api/reviews/${encodeURIComponent(id)}`);
    renderDetail(data);
    if (escalate) {
      if (data.escalation && data.escalation.ready && data.escalation.teams) renderEscalate(data);
      else toast("Escalation isn't set up yet. See Settings.", true);
    }
  } catch (e) {
    d.innerHTML = `<button class="close" aria-label="Close" onclick="closeDetail()">\u00d7</button><p>${esc(e.message)}</p>`;
  }
}

function closeDetail() {
  state.selected = null;
  $("#detail").hidden = true;
  document.querySelector(".shell").classList.remove("with-detail");
  document.querySelectorAll(".row").forEach((b) => b.setAttribute("aria-current", "false"));
}
window.closeDetail = closeDetail;

function renderDetail(data) {
  state.detail = data;
  const { review: r, events, escalation } = data;
  const canAct = state.me.role !== "viewer";
  const answered = ANSWERED.includes(r.status);
  const live = state.me.mode === "live";
  let flags = [];
  try { flags = JSON.parse(r.risk_flags || "[]"); } catch { /* ignore */ }

  let replyBlock = "";
  if (answered) {
    replyBlock = `<label class="lbl">Posted reply</label><div class="posted-reply">${esc(r.reply_text || "")}</div>
      <p class="meta">${r.reply_time ? "Replied " + ago(r.reply_time) : ""}</p>`;
  } else if (r.status === "dismissed") {
    replyBlock = `<p class="reason">Dismissed${r.decided_by ? " by <b>" + esc(r.decided_by) + "</b>" : ""}. No reply will be posted from here.</p>
      ${canAct ? `<div class="actions"><button class="btn" data-act="reopen">Move back to inbox</button></div>` : ""}`;
  } else if (!r.draft && (r.status === "new" || r.status === "old_unanswered")) {
    replyBlock = `<p class="reason">${r.status === "new" ? "A draft will be written on the next agent run." : "This review is older than the drafting window, so no draft was written."}</p>
      ${canAct ? `<div class="actions"><button class="btn primary" data-act="redraft">Write a draft now</button></div>` : ""}`;
  } else {
    const approveLabel = live && !r.is_sample ? "Approve and post" : "Approve";
    replyBlock = `<label class="lbl" for="replyText">Reply</label>
      <textarea id="replyText" ${canAct ? "" : "readonly"}>${esc(r.draft || "")}</textarea>
      ${canAct ? `<div class="actions">
        <button class="btn primary" data-act="approve">${approveLabel}</button>
        <button class="btn" data-act="save">Save edits</button>
        <button class="btn" data-act="redraft">Redraft</button>
        <button class="btn quiet danger" data-act="dismiss">Dismiss</button>
      </div>` : ""}
      ${!live ? `<p class="meta">The agent isn't live yet, so approved replies are saved and will post once it goes live.</p>` : ""}`;
  }

  const reason = r.route_reason
    ? `<p class="reason"><b>Why it's here:</b> ${esc(r.route_reason)}${flags.length && !r.route_reason.includes(flags[0]) ? ". " + esc(flags.join(", ")) : ""}</p>` : "";

  $("#detail").innerHTML = `
    <div class="detail-head">
      <div><h2>${esc(storeName(r.rooftop_key))}</h2><p class="meta">${new Date(r.create_time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</p></div>
      <div class="head-actions">
        ${canAct && escalation && escalation.ready && escalation.teams ? `<button class="btn escalate" id="escalateBtn">${r.escalation_open ? "Follow up" : "Escalate"}</button>` : ""}
        <button class="close" aria-label="Close" onclick="closeDetail()">\u00d7</button>
      </div>
    </div>
    <div>${stars(r.stars, "big-stars")}</div>
    <div>${pill(r.status, r.is_sample)}</div>
    <blockquote>${r.text ? esc(r.text) : "<em>Rating only, no written review</em>"}</blockquote>
    ${reason}
    ${replyBlock}
    ${escalationBlock(r, escalation, canAct)}
    <div class="history"><h3>History</h3>
      ${events.length ? `<ol>${events.map((e) => `<li><b>${esc(eventLabel(e.action))}</b> by ${esc(e.actor)}, ${ago(e.at)}${e.detail ? ". " + esc(e.detail) : ""}</li>`).join("")}</ol>` : `<p class="meta">No actions yet.</p>`}
    </div>`;

  $("#detail").querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => act(r.id, b.dataset.act, b)));
  const escBtn = $("#escalateBtn");
  if (escBtn) escBtn.onclick = () => renderEscalate(state.detail);
}

function eventLabel(a) {
  return { drafted: "Drafted", edited: "Edited", approved: "Approved", posted: "Posted", dismissed: "Dismissed", reopened: "Reopened",
    escalated: "Emailed the team", escalation_resolved: "Marked resolved" }[a] || a;
}

async function act(id, action, btn) {
  const body = {};
  const ta = $("#replyText");
  if (ta) body.reply = ta.value;
  if (action === "dismiss") {
    const note = prompt("Dismiss this review? It won't get a reply from here. Add a note (optional):", "");
    if (note === null) return;
    body.note = note;
  }
  const buttons = $("#detail").querySelectorAll("[data-act]");
  buttons.forEach((b) => (b.disabled = true));
  const old = btn.textContent;
  if (action === "redraft") btn.textContent = "Writing\u2026";
  try {
    const data = await api(`/api/reviews/${encodeURIComponent(id)}/${action}`, { method: "POST", body });
    renderDetail(data);
    const r = data.review;
    toast({ approve: r.status === "approved_posted" ? "Reply posted to Google" : "Reply approved", save: "Edits saved", redraft: "New draft written", dismiss: "Review dismissed", reopen: "Moved back to inbox", resolve: "Escalation marked resolved" }[action]);
    const i = state.rows.findIndex((x) => x.id === id);
    if (i >= 0) state.rows[i] = r;
    if (state.view === "inbox") state.rows = state.rows.filter((x) => ["new", "pending", "error"].includes(x.status));
    if (state.view === "escalations") state.rows = state.rows.filter((x) => (x.escalation_open || 0) > 0);
    renderList(false);
    refreshCounts();
  } catch (e) {
    toast(e.message, true);
    buttons.forEach((b) => (b.disabled = false));
    btn.textContent = old;
  }
}

/* ---------- Escalations ---------- */

async function resolveFromList(id, btn) {
  btn.disabled = true;
  try {
    await api(`/api/reviews/${encodeURIComponent(id)}/resolve`, { method: "POST" });
    state.rows = state.rows.filter((x) => x.id !== id);
    if (state.selected === id) closeDetail();
    renderList(false);
    refreshCounts();
    toast("Marked resolved and removed from Escalations");
  } catch (err) { toast(err.message, true); btn.disabled = false; }
}

function escalationBlock(r, e, canAct) {
  if (!e || !e.ready) return "";
  const count = r.escalation_count || 0, open = r.escalation_open || 0;
  const summary = count
    ? `<p class="esc-summary"><span class="esc-count">${count}</span> ${count === 1 ? "email" : "emails"} sent to the team. Last ${ago(r.escalation_last_at)}.
       ${open > 1 ? `<b>${open - 1} follow-up${open - 1 === 1 ? "" : "s"} without resolution.</b>` : open === 1 ? "Waiting on the team." : "Resolved."}</p>` : "";
  const buttons = canAct && open ? `<div class="actions"><button class="btn quiet" data-act="resolve">Mark resolved</button></div>` : "";
  if (!summary && !buttons) return "";
  return `<div class="esc-block"><h3>Escalation</h3>${summary}${buttons}</div>`;
}

const FIELD_INPUTS = {
  dms: ["Client / DMS #", "text"], client: ["Client name", "text"],
  salesperson: ["Salesperson", "text"], deal: ["Deal #", "text"], dealDate: ["Deal date", "date"],
  ro: ["RO #", "text"], roDate: ["RO date", "date"], advisor: ["Service advisor", "text"],
};

function renderEscalate(data) {
  const { review: r, escalation: e } = data;
  const guess = r.department === "sales" ? "sales" : r.department === "service" ? "service" : "";
  const f = { concern: guess, fields: {}, note: "", wholeStore: false, extras: [], removed: new Set() };
  const d = $("#detail");

  const base = () => {
    if (!f.concern) return [];
    const teams = f.wholeStore ? ["store"] : e.teamsFor[f.concern];
    return [...new Set(teams.flatMap((t) => e.teams[t] || []))];
  };
  const recipients = () => [...new Set([...base(), ...f.extras])].filter((a) => !f.removed.has(a));

  const draw = () => {
    const fieldsHtml = f.concern ? e.fieldsFor[f.concern].map((k) => {
      const [label, type] = FIELD_INPUTS[k];
      return `<label class="field">${label}<input type="${type}" data-field="${k}" value="${esc(f.fields[k] || "")}" autocomplete="off"></label>`;
    }).join("") : "";
    const list = recipients();
    const emptyTeams = f.concern && !base().length;
    const teamNames = f.wholeStore ? "entire store" : (e.teamsFor[f.concern] || []).join(" and ");
    d.innerHTML = `
      <div class="detail-head"><div><h2>Escalate to the team</h2><p class="meta">${esc(storeName(r.rooftop_key))}, ${r.stars || "no"} star review</p></div>
        <button class="close" aria-label="Back to review" id="escBack">\u00d7</button></div>
      ${!e.mailReady ? `<p class="late">Email sending isn't set up yet, so you can preview but not send. See the README.</p>`
        : !e.canSend ? `<p class="late">Before you can send, <a href="/auth/logout">sign out</a> and sign back in once so Microsoft lets this app send from your mailbox. You can still fill this out and preview.</p>` : ""}
      ${(r.escalation_open || 0) > 0 ? `<p class="note">This will be follow-up #${r.escalation_open} on this review.</p>` : ""}
      <fieldset class="field concern"><legend>What is this about?</legend>
        ${["sales", "service", "both", "other"].map((c) => `<label><input type="radio" name="concern" value="${c}" ${f.concern === c ? "checked" : ""}> ${{ sales: "Sales", service: "Service", both: "Both", other: "Other" }[c]}</label>`).join("")}
      </fieldset>
      ${f.concern ? `
        <div class="esc-fields">${fieldsHtml}</div>
        <p class="note">Customer details are optional. If you add any, the email opens with "We believe the customer that left the review is:". They go in the email only and aren't saved in the dashboard.</p>
        <label class="field">Note<textarea id="escNote" rows="5" placeholder="What should the team do?">${esc(f.note)}</textarea></label>
        <div class="field"><span>Send to</span>
          <label class="check"><input type="checkbox" id="wholeStore" ${f.wholeStore ? "checked" : ""}> Send to the entire store instead</label>
          ${emptyTeams ? `<p class="late">No ${teamNames} list for this store yet. Add one in Settings, or add people below.</p>` : ""}
          <div class="chips">${list.map((a) => `<span class="chip">${esc(a)}<button type="button" aria-label="Remove ${esc(a)}" data-remove="${esc(a)}">\u00d7</button></span>`).join("") || `<span class="meta">Nobody yet</span>`}</div>
          <div class="add-row"><input type="email" id="addEmail" placeholder="Add someone (name@${esc(e.domains[0] || "lesterglenn.com")})"><button class="btn" id="addBtn" type="button">Add</button></div>
          <p class="meta">People added here are for this email only. It sends from your own mailbox, so replies come to you and a copy lands in your Sent Items.</p>
        </div>
        <div class="actions"><button class="btn primary" id="previewBtn">Preview email</button><button class="btn quiet" id="cancelEsc">Cancel</button></div>` : ""}`;

    $("#escBack").onclick = () => renderDetail(state.detail);
    d.querySelectorAll('input[name="concern"]').forEach((i) => (i.onchange = () => { save(); f.concern = i.value; f.removed.clear(); draw(); }));
    if (!f.concern) return;
    $("#cancelEsc").onclick = () => renderDetail(state.detail);
    $("#wholeStore").onchange = (ev) => { save(); f.wholeStore = ev.target.checked; draw(); };
    d.querySelectorAll("[data-remove]").forEach((b) => (b.onclick = () => { save(); f.removed.add(b.dataset.remove); f.extras = f.extras.filter((x) => x !== b.dataset.remove); draw(); }));
    const add = () => {
      const v = $("#addEmail").value.trim().toLowerCase();
      if (!v) return;
      const dom = v.split("@")[1];
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(v) || !e.domains.includes(dom)) { toast(`Only ${e.domains.join(", ")} addresses can be added.`, true); return; }
      save(); f.removed.delete(v); if (!f.extras.includes(v)) f.extras.push(v); draw(); $("#addEmail").focus();
    };
    $("#addBtn").onclick = add;
    $("#addEmail").onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); add(); } };
    $("#previewBtn").onclick = async (ev) => {
      save();
      ev.target.disabled = true;
      try {
        const p = await api(`/api/reviews/${encodeURIComponent(r.id)}/escalate`, { method: "POST", body: payload(true) });
        preview(p);
      } catch (err) { toast(err.message, true); ev.target.disabled = false; }
    };
  };

  const save = () => {
    d.querySelectorAll("[data-field]").forEach((i) => (f.fields[i.dataset.field] = i.value));
    if ($("#escNote")) f.note = $("#escNote").value;
  };
  const payload = (isPreview) => ({ concern: f.concern, fields: f.fields, note: f.note, recipients: recipients(), preview: isPreview });

  const preview = (p) => {
    d.innerHTML = `
      <div class="detail-head"><div><h2>Check and send</h2><p class="meta">From you (${esc(p.from)}) to ${p.recipients.length} ${p.recipients.length === 1 ? "person" : "people"}</p></div>
        <button class="close" aria-label="Back to review" id="escBack">\u00d7</button></div>
      <p class="meta"><b>To:</b> ${p.recipients.map(esc).join(", ")}</p>
      <p class="meta"><b>Subject:</b> ${esc(p.subject)}</p>
      <iframe class="email-preview" sandbox="" title="Email preview"></iframe>
      <div class="actions"><button class="btn primary" id="sendBtn" ${e.mailReady ? "" : "disabled"}>Send email</button><button class="btn" id="editBtn">Edit</button></div>
      <div id="signInAgain"></div>`;
    d.querySelector(".email-preview").srcdoc = p.html;
    $("#escBack").onclick = () => renderDetail(state.detail);
    $("#editBtn").onclick = draw;
    $("#sendBtn").onclick = async (ev) => {
      ev.target.disabled = true; ev.target.textContent = "Sending\u2026";
      try {
        const data2 = await api(`/api/reviews/${encodeURIComponent(r.id)}/escalate`, { method: "POST", body: payload(false) });
        renderDetail(data2);
        const i = state.rows.findIndex((x) => x.id === r.id);
        if (i >= 0) { state.rows[i] = data2.review; renderList(false); }
        toast("Email sent to the team");
        refreshCounts();
      } catch (err) {
        ev.target.disabled = false; ev.target.textContent = "Send email";
        if (err.data && err.data.signIn) {
          $("#signInAgain").innerHTML = `<p class="late" style="margin-top:12px">${esc(err.message)} Copy your note first, since signing out clears this form.</p>
            <a class="btn" href="/auth/logout">Sign out</a>`;
        } else toast(err.message, true);
      }
    };
  };

  draw();
}

/* ---------- Statistics ---------- */

async function renderStats() {
  const v = $("#view");
  closeDetail();
  const days = state.statsDays;
  const range = `<div class="filters"><label for="sDays" class="sr">Time range</label>
    <select id="sDays">${[[30, "Last 30 days"], [90, "Last 90 days"], [365, "Last 12 months"], [0, "All time"]]
      .map(([d, l]) => `<option value="${d}" ${d === days ? "selected" : ""}>${l}</option>`).join("")}</select></div>`;
  v.innerHTML = range + `<div class="empty-state">Crunching the numbers\u2026</div>`;
  $("#sDays").onchange = (e) => { state.statsDays = parseInt(e.target.value, 10); renderStats(); };
  const q = new URLSearchParams({ days: String(days) });
  if (state.rooftop) q.set("rooftop", state.rooftop);
  let s;
  try { s = await api(`/api/stats?${q}`); } catch (e) {
    v.innerHTML = range + `<div class="empty-state"><strong>Statistics didn't load</strong>${esc(e.message)}</div>`;
    return;
  }
  const o = s.overall;
  if (!o.total) {
    v.innerHTML = range + `<div class="empty-state"><strong>No reviews in this range</strong>Pick a longer time range or another store.</div>`;
    $("#sDays").onchange = (e) => { state.statsDays = parseInt(e.target.value, 10); renderStats(); };
    return;
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const replied = (o.by_agent || 0) + (o.by_manager || 0) + (o.by_google || 0);

  const kpis = `<div class="kpis">
    <div class="kpi"><div class="fig">${pct(o.answered, o.total)}<small>%</small></div><div class="cap">Response rate</div></div>
    <div class="kpi"><div class="fig">${hoursLabel(o.avg_hours)}</div><div class="cap">Average time to reply</div></div>
    <div class="kpi"><div class="fig">${pct(o.within_24, o.answered)}<small>%</small></div><div class="cap">Replies within 24 hours</div></div>
    <div class="kpi"><div class="fig">${o.avg_stars ?? "\u2013"}</div><div class="cap">Average rating, ${o.total} reviews</div></div>
    <div class="kpi"><div class="fig">${o.open}</div><div class="cap">Still unanswered</div></div>
  </div>`;

  const rows = s.rooftops.slice().sort((a, b) => b.total - a.total).map((r) => {
    const rate = pct(r.answered, r.total);
    const oldest = r.oldest_open ? (Date.now() - Date.parse(r.oldest_open)) / 86400000 : null;
    return `<tr><td>${esc(r.name.replace(/^Lester Glenn /, ""))}</td><td class="num">${r.total}</td><td class="num">${r.avg_stars ?? "\u2013"}</td>
      <td><div class="rate"><div class="bar"><span class="${rate < 80 ? "warn" : ""}" style="width:${rate}%"></span></div>${rate}%</div></td>
      <td class="num">${r.avg_hours == null ? "\u2013" : r.avg_hours < 48 ? Math.round(r.avg_hours) + " hr" : (r.avg_hours / 24).toFixed(1) + " days"}</td>
      <td class="num">${r.open}</td>
      <td class="num ${oldest > 3 ? "late" : ""}">${oldest == null ? "\u2013" : oldest < 1 ? "Today" : Math.round(oldest) + " days"}</td></tr>`;
  }).join("");
  const table = s.rooftops.length > 1 || !state.rooftop ? `<div class="panel"><h3>By store</h3>
    <p class="note">Response rates under 80% show in red. Oldest open review turns red after 3 days.</p>
    <div class="table-wrap"><table><thead><tr><th>Store</th><th class="num">Reviews</th><th class="num">Rating</th><th>Response rate</th>
    <th class="num">Avg reply time</th><th class="num">Unanswered</th><th class="num">Oldest open</th></tr></thead><tbody>${rows}</tbody></table></div></div>` : "";

  const dist = [5, 4, 3, 2, 1].map((n) => {
    const c = s.stars.find((x) => x.stars === n)?.n || 0;
    return `<span>${n} \u2605</span><div class="bar"><span style="width:${pct(c, o.total)}%"></span></div><span>${c}</span>`;
  }).join("");

  v.innerHTML = range + kpis + table + `<div class="split">
    <div class="panel chart"><h3>Reviews and replies by month</h3>${monthlyChart(s.monthly)}
      <div class="legend"><span><i style="background:var(--line)"></i>Reviews</span><span><i style="background:var(--blue)"></i>Answered</span></div></div>
    <div>
      <div class="panel"><h3>Rating mix</h3><div class="dist">${dist}</div></div>
      <div class="panel"><h3>Who replied</h3><div class="dist">
        <span>Agent, automatic</span><div class="bar"><span style="width:${pct(o.by_agent, replied)}%;background:var(--blue)"></span></div><span>${o.by_agent || 0}</span>
        <span>Approved in dashboard</span><div class="bar"><span style="width:${pct(o.by_manager, replied)}%;background:var(--green)"></span></div><span>${o.by_manager || 0}</span>
        <span>Directly in Google</span><div class="bar"><span style="width:${pct(o.by_google, replied)}%;background:var(--muted)"></span></div><span>${o.by_google || 0}</span>
      </div></div>
    </div></div>`;
  $("#sDays").onchange = (e) => { state.statsDays = parseInt(e.target.value, 10); renderStats(); };
}

function monthlyChart(months) {
  const data = months.slice(-12);
  if (!data.length) return `<p class="note">Not enough data yet.</p>`;
  const W = 600, H = 220, pad = 28, bw = (W - pad) / data.length;
  const max = Math.max(...data.map((m) => m.total), 1);
  const y = (v) => H - pad - (v / max) * (H - pad - 10);
  const bars = data.map((m, i) => {
    const x = pad + i * bw + bw * 0.18, w = bw * 0.64;
    const label = new Date(m.month + "-02").toLocaleDateString(undefined, { month: "short" });
    return `<rect x="${x}" y="${y(m.total)}" width="${w}" height="${H - pad - y(m.total)}" fill="var(--line)" rx="2"><title>${m.total} reviews</title></rect>
      <rect x="${x + w * 0.2}" y="${y(m.answered)}" width="${w * 0.6}" height="${H - pad - y(m.answered)}" fill="var(--blue)" rx="2"><title>${m.answered} answered</title></rect>
      <text x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${label}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly reviews and replies">
    <text x="0" y="${y(max) + 4}">${max}</text><line x1="${pad}" x2="${W}" y1="${H - pad}" y2="${H - pad}" stroke="var(--line)"/>${bars}</svg>`;
}

/* ---------- Settings (admins) ---------- */

async function renderSettings() {
  closeDetail();
  const v = $("#view");
  v.innerHTML = `<div class="empty-state">Loading settings\u2026</div>`;
  let users, runs;
  let guide, teams;
  try { [users, runs, guide, teams] = await Promise.all([api("/api/admin/users"), api("/api/admin/runs"), api("/api/admin/guidelines"), api("/api/admin/teams")]); }
  catch (e) { v.innerHTML = `<div class="empty-state"><strong>Settings didn't load</strong>${esc(e.message)}</div>`; return; }
  const m = state.me.mode;
  const modeText = {
    dry_run: "Dry run. The agent only works with sample data and never touches Google. Scheduled runs are paused in this mode; use Run agent now to test.",
    shadow: "Shadow. The agent reads real Google reviews at 8am, 12pm, 4pm, and 8pm Eastern and writes drafts, but never posts.",
    live: "Live. Four times a day, positive, low-risk replies post automatically, and approved replies post right away.",
  }[m];

  const roleName = { admin: "Admin", manager: "Manager", viewer: "View only" };
  const userRows = users.builtInAdmins.map((e) => `<tr><td>${esc(e)}</td><td>Admin</td><td>All stores</td><td class="num"><span class="meta">Set in wrangler.toml</span></td></tr>`).join("") +
    users.users.map((u) => `<tr><td>${esc(u.email)}</td><td>${roleName[u.role]}</td>
      <td>${u.rooftops === "*" ? "All stores" : u.rooftops.split(",").map(storeName).map((n) => esc(n.replace(/^Lester Glenn /, ""))).join(", ")}</td>
      <td class="num"><button class="btn quiet danger" data-remove="${esc(u.email)}">Remove</button></td></tr>`).join("");

  const runRows = runs.runs.map((r) => `<tr><td>${ago(r.started_at)}</td><td>${esc(r.trigger.replace(/^manual:.*/, "Manual"))}</td>
    <td class="num">${r.synced}</td><td class="num">${r.drafted}</td><td class="num">${r.flagged}</td><td class="num">${r.posted}</td>
    <td class="num ${r.errors ? "late" : ""}">${r.errors}</td></tr>${r.notes ? `<tr><td colspan="7" class="meta" style="white-space:pre-wrap">${esc(r.notes)}</td></tr>` : ""}`).join("");

  const locRows = runs.locations.map((l) => `<tr><td>${esc(l.title)}</td><td>${esc(storeName(l.rooftop_key))}</td>
    <td>${l.backfill_done ? "Complete" : "Importing older reviews"}</td><td>${l.updated_at ? ago(l.updated_at) : "\u2013"}</td></tr>`).join("");

  v.innerHTML = `<div class="settings-grid">
    <div class="panel"><h3>Agent</h3><p>${modeText}</p>
      <p class="note">To change modes, edit <code>AGENT_MODE</code> in wrangler.toml and deploy again.</p>
      <div class="actions"><button class="btn primary" id="runNow">Run agent now</button>
      ${m === "dry_run" ? `<button class="btn" id="loadSamples">Load sample data</button>` : ""}
      <button class="btn quiet danger" id="clearSamples">Clear sample data</button></div>
      <p class="meta" id="runResult"></p></div>
    <div class="panel"><h3>Add or update a person</h3>
      <form id="userForm" onsubmit="return false">
        <label class="field">Microsoft email<input type="email" id="uEmail" required placeholder="name@lesterglenn.com" autocomplete="off"></label>
        <label class="field">Role<select id="uRole"><option value="manager">Manager: review and approve replies</option>
          <option value="viewer">View only: reviews and statistics</option><option value="admin">Admin: everything, including settings</option></select></label>
        <fieldset class="field" style="border:0;padding:0;margin:0 0 10px"><legend>Stores (leave all unchecked for every store)</legend>
          <div class="checks">${users.rooftops.filter((r) => r.key !== "other").map((r) => `<label><input type="checkbox" value="${esc(r.key)}"> ${esc(r.name.replace(/^Lester Glenn /, ""))}</label>`).join("")}</div></fieldset>
        <button class="btn primary" id="saveUser">Save person</button>
      </form>
      <p class="note" style="margin-top:12px">They sign in with their Lester Glenn Microsoft account.</p></div>
  </div>
  ${teamsPanel(teams, users.rooftops)}
  <div class="panel" id="guidePanel"><h3>Reply guidelines</h3>
    <p class="note">${guide.custom ? `Custom guidelines saved by ${esc(guide.updatedBy || "an admin")}${guide.updatedAt ? ", " + ago(guide.updatedAt) : ""}.` : "Using the built-in starter guidelines."}
      Claude follows these for every draft. Privacy and safety rules are always added on top, so they can't be edited away.</p>
    ${guide.needsSetup ? `<p class="late">One-time setup needed: run the SQL in <code>migrations/0002_settings.sql</code> in the D1 console, then reload this page.</p>` : `
    <div class="actions" style="margin:0 0 12px">
      <button class="btn primary" id="learnGoogle" ${guide.available < guide.minReplies ? "disabled" : ""}>Learn from our Google replies (${guide.available} on file)</button>
      <button class="btn" id="showPaste">Paste replies instead</button>
    </div>
    ${guide.available < guide.minReplies ? `<p class="note">Learning from Google needs at least ${guide.minReplies} replies your team wrote. They'll be on file once the agent syncs real reviews in shadow or live mode. Until then, paste replies.</p>` : ""}
    <div id="pasteBox" hidden>
      <label class="field">Paste past replies (copy them from Google Business Profile, one after another; including the review text helps)
        <textarea id="pasteText" rows="8" style="width:100%;border:1px solid var(--line);border-radius:6px;padding:10px;font-weight:400"></textarea></label>
      <button class="btn primary" id="learnPaste">Write guidelines from these</button>
    </div>
    <label class="field" for="guideText" style="margin-top:12px">Guidelines (edit freely, then save)</label>
    <textarea id="guideText" rows="22" style="width:100%;border:1px solid var(--line);border-radius:6px;padding:10px 12px;line-height:1.5;background:var(--panel)">${esc(guide.text)}</textarea>
    <div class="actions">
      <button class="btn primary" id="saveGuide">Save guidelines</button>
      ${guide.custom ? `<button class="btn quiet danger" id="resetGuide">Go back to built-in guidelines</button>` : ""}
    </div>
    <p class="meta" id="guideStatus"></p>`}
  </div>
  <div class="panel"><h3>People with access</h3><div class="table-wrap"><table><thead><tr><th>Email</th><th>Role</th><th>Stores</th><th></th></tr></thead>
    <tbody id="userRows">${userRows}</tbody></table></div></div>
  <div class="panel"><h3>Recent agent runs</h3>${runRows ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Trigger</th><th class="num">Synced</th>
    <th class="num">Drafted</th><th class="num">Flagged</th><th class="num">Posted</th><th class="num">Errors</th></tr></thead><tbody>${runRows}</tbody></table></div>` : `<p class="note">No runs yet.</p>`}</div>
  ${locRows ? `<div class="panel"><h3>Google locations</h3><div class="table-wrap"><table><thead><tr><th>Google listing</th><th>Matched store</th><th>History import</th><th>Last synced</th></tr></thead><tbody>${locRows}</tbody></table></div></div>` : ""}`;

  if (!guide.needsSetup) bindGuidelines();
  if (teams.ready) bindTeams(teams);
  $("#runNow").onclick = async (e) => {
    const b = e.target; b.disabled = true; b.textContent = "Running\u2026";
    try {
      const r = await api("/api/admin/run", { method: "POST" });
      toast(`Run finished: ${r.drafted} drafted, ${r.flagged} flagged, ${r.posted} posted`);
      await refreshCounts(); renderSettings();
    } catch (err) { toast(err.message, true); b.disabled = false; b.textContent = "Run agent now"; }
  };
  const samples = async (action, b) => {
    if (action === "clear" && !confirm("Remove all sample reviews? Real reviews are not affected.")) return;
    b.disabled = true;
    try {
      const r = await api("/api/admin/samples", { method: "POST", body: { action } });
      toast(action === "load" ? `Loaded ${r.loaded} sample reviews` : "Sample data cleared");
      await refreshCounts(); renderSettings();
    } catch (err) { toast(err.message, true); b.disabled = false; }
  };
  if ($("#loadSamples")) $("#loadSamples").onclick = (e) => samples("load", e.target);
  $("#clearSamples").onclick = (e) => samples("clear", e.target);
  $("#saveUser").onclick = async () => {
    const rooftops = [...document.querySelectorAll(".checks input:checked")].map((c) => c.value);
    try {
      await api("/api/admin/users", { method: "POST", body: { email: $("#uEmail").value, role: $("#uRole").value, rooftops } });
      toast("Person saved"); renderSettings();
    } catch (err) { toast(err.message, true); }
  };
  $("#userRows").onclick = async (e) => {
    const b = e.target.closest("[data-remove]");
    if (!b || !confirm(`Remove access for ${b.dataset.remove}?`)) return;
    try {
      await api(`/api/admin/users?email=${encodeURIComponent(b.dataset.remove)}`, { method: "DELETE" });
      toast("Access removed"); renderSettings();
    } catch (err) { toast(err.message, true); }
  };
}

function teamsPanel(t, rooftops) {
  if (!t.ready) return `<div class="panel"><h3>Escalation teams</h3><p class="late">One-time setup needed: run the SQL in <code>migrations/0003_escalations.sql</code> in the D1 console, then reload this page.</p></div>`;
  const stores = rooftops.filter((r) => r.key !== "other");
  const count = (key, team) => (t.rows.find((x) => x.rooftop_key === key && x.team === team)?.emails || "").split(",").filter(Boolean).length;
  return `<div class="panel" id="teamsPanel"><h3>Escalation teams</h3>
    <p class="note">Who gets the email when someone escalates a review. Sales concerns go to the Sales list, Service to Service, Both to both lists, and Other to the Entire store list.
      Each email sends from the Outlook mailbox of the person who escalates.</p>
    <div class="table-wrap"><table><thead><tr><th>Store</th><th class="num">Sales</th><th class="num">Service</th><th class="num">Entire store</th></tr></thead><tbody>
      ${stores.map((r) => `<tr><td>${esc(r.name.replace(/^Lester Glenn /, ""))}</td>${["sales", "service", "store"].map((tm) => `<td class="num ${count(r.key, tm) ? "" : "late"}">${count(r.key, tm) || "None"}</td>`).join("")}</tr>`).join("")}
    </tbody></table></div>
    <label class="field" style="margin-top:14px">Edit lists for<select id="teamStore">${stores.map((r) => `<option value="${esc(r.key)}">${esc(r.name)}</option>`).join("")}</select></label>
    <div class="team-edit">
      ${["sales", "service", "store"].map((tm) => `<label class="field">${{ sales: "Sales", service: "Service", store: "Entire store" }[tm]}
        <textarea data-team="${tm}" rows="5" placeholder="One email per line"></textarea></label>`).join("")}
    </div>
    <p class="meta">Only ${t.domains.map(esc).join(", ")} addresses are allowed.</p>
    <div class="actions"><button class="btn primary" id="saveTeams">Save lists for this store</button></div>
  </div>`;
}

function bindTeams(t) {
  const fill = () => {
    const key = $("#teamStore").value;
    document.querySelectorAll("[data-team]").forEach((ta) => {
      ta.value = (t.rows.find((x) => x.rooftop_key === key && x.team === ta.dataset.team)?.emails || "").split(",").filter(Boolean).join("\n");
    });
  };
  $("#teamStore").onchange = fill;
  fill();
  $("#saveTeams").onclick = async (e) => {
    const body = { rooftop: $("#teamStore").value };
    document.querySelectorAll("[data-team]").forEach((ta) => (body[ta.dataset.team] = ta.value));
    e.target.disabled = true;
    try {
      await api("/api/admin/teams", { method: "POST", body });
      toast("Lists saved");
      const keep = body.rooftop;
      await renderSettings();
      $("#teamStore").value = keep; $("#teamStore").dispatchEvent(new Event("change"));
    } catch (err) { toast(err.message, true); e.target.disabled = false; }
  };
}

function bindGuidelines() {
  const status = $("#guideStatus");
  const learn = async (source, btn) => {
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = "Reading replies\u2026 (about a minute)";
    status.textContent = "";
    try {
      const r = await api("/api/admin/guidelines/learn", { method: "POST", body: { source, text: source === "pasted" ? $("#pasteText").value : "" } });
      $("#guideText").value = r.draft;
      status.textContent = (r.used ? `Written from ${r.used} of your team's replies. ` : "Written from your pasted replies. ") +
        "Nothing is saved yet: read it over, edit anything, then click Save guidelines.";
      $("#guideText").focus();
      $("#guideText").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) { toast(err.message, true); }
    btn.disabled = false; btn.textContent = old;
  };
  if ($("#learnGoogle")) $("#learnGoogle").onclick = (e) => learn("google", e.target);
  $("#showPaste").onclick = () => { $("#pasteBox").hidden = !$("#pasteBox").hidden; if (!$("#pasteBox").hidden) $("#pasteText").focus(); };
  $("#learnPaste").onclick = (e) => learn("pasted", e.target);
  $("#saveGuide").onclick = async (e) => {
    e.target.disabled = true;
    try {
      await api("/api/admin/guidelines", { method: "POST", body: { action: "save", text: $("#guideText").value } });
      toast("Guidelines saved. New drafts will follow them.");
      renderSettings();
    } catch (err) { toast(err.message, true); e.target.disabled = false; }
  };
  if ($("#resetGuide")) $("#resetGuide").onclick = async () => {
    if (!confirm("Go back to the built-in guidelines? Your custom version is kept as a backup in the database.")) return;
    try { await api("/api/admin/guidelines", { method: "POST", body: { action: "reset" } }); toast("Back to built-in guidelines"); renderSettings(); }
    catch (err) { toast(err.message, true); }
  };
}

boot();
