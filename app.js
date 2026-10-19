import { createClient } from "./supabase-client.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";
import { buildVaccinationView, neutralPlanSourceStatus } from "./vaccination.mjs";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false
  }
});

const loading = document.querySelector("#loading");
const login = document.querySelector("#login");
const app = document.querySelector("#app");
const view = document.querySelector("#view");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const loginStatus = document.querySelector("#login-status");
const recoveryRequest = document.querySelector("#recovery-request");
const recoveryReset = document.querySelector("#recovery-reset");
const recoveryRequestForm = document.querySelector("#recovery-request-form");
const recoveryResetForm = document.querySelector("#recovery-reset-form");
const logoutButton = document.querySelector("#logout");

const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

// Operational timestamps are stored as UTC instants and displayed in Moscow time.
const fmtMskTimestamp = (value) => {
  if (!value) return "";
  const stamp = new Date(value);
  return Number.isNaN(stamp.getTime()) ? String(value) :
    new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).format(stamp);
};

const fmtDate = (value) => {
  if (!value) return "";
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(value);
};

const recLink = (recordId, label = recordId) =>
  `<a href="#/records/${encodeURIComponent(recordId)}">${esc(label)}</a>`;

const caseLink = (caseKey, label) =>
  `<a href="#/cases/${encodeURIComponent(caseKey)}">${esc(label || caseKey)}</a>`;

function showOnly(target) {
  for (const el of [loading, login, app, recoveryRequest, recoveryReset]) el.classList.add("hidden");
  target.classList.remove("hidden");
}

function empty(label = "Пока нет данных") {
  return `<p class="empty">${esc(label)}</p>`;
}

function list(items, renderItem) {
  if (!items?.length) return empty();
  return `<ul class="cards">${items.map(renderItem).join("")}</ul>`;
}

function chips(items) {
  const values = (items || []).filter(Boolean);
  if (!values.length) return "";
  return `<span class="chips">${values.map(x => `<span class="chip">${esc(x)}</span>`).join("")}</span>`;
}

const tableCell = (html, filterValue = "") => ({
  html,
  filterValue: String(filterValue ?? "")
});

const normalizeFilter = (value) => String(value ?? "").trim().toLocaleLowerCase("ru");
const recordTagFilters = new Set();
let uiGeneration = 0;

// #40A: calendar-only neutral projection. This is NOT a medical overdue verdict.
const NEUTRAL_DATE_TEXT = "Указанная дата прошла. Уточните выполнение или перенос";
const MOSCOW_DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone:"Europe/Moscow",year:"numeric",month:"2-digit",day:"2-digit"
});
function moscowCalendarDay(now=new Date()) {
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw new TypeError("Invalid clock");
  const v=Object.fromEntries(MOSCOW_DATE.formatToParts(now).map(x=>[x.type,x.value]));
  return v.year+"-"+v.month+"-"+v.day;
}
function strictCalendarDate(x) {
  if(typeof x!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(x))return null;
  const [y,m,d]=x.split("-").map(Number),t=new Date(0);
  if(y<1||m<1||m>12||d<1||d>31)return null;
  t.setUTCFullYear(y,m-1,d);t.setUTCHours(0,0,0,0);
  return t.getUTCFullYear()===y&&t.getUTCMonth()===m-1&&t.getUTCDate()===d?x:null;
}
function uncertainDate(meta) {
  // Fail closed for unknown types in fields that qualify a clinical date.
  // Only an absent/empty qualifier is safe to ignore; no metadata value is
  // interpreted as independent proof of an unconditional medical obligation.
  if (meta == null) return false;
  if (typeof meta !== "object" || Array.isArray(meta)) return true;
  const status = meta.source_status;
  if (status != null) {
    if (typeof status !== "string") return true;
    const normalized = status.trim().toLocaleLowerCase("ru");
    if (normalized && !["planned", "запланировано"].includes(normalized)) return true;
  }
  const dueText = meta.due_text;
  if (dueText != null) {
    if (typeof dueText !== "string" || dueText.trim()) return true;
  }
  if (meta.historical != null && meta.historical !== false) return true;
  if (meta.date_kind != null && meta.date_kind !== "") return true;
  if (meta.deadline_condition != null && meta.deadline_condition !== "" &&
      meta.deadline_condition !== false) return true;
  return false;
}
function projectNeutralDates(rows,now=new Date()) {
  if(!Array.isArray(rows))throw new TypeError("Expected plan rows");
  const today=moscowCalendarDay(now),groups=new Map();
  for(const row of rows) {
    if(!Number.isSafeInteger(row?.plan_item_id)||row.plan_item_id<=0)continue;
    const bucket=groups.get(row.plan_item_id)||[];bucket.push(row);groups.set(row.plan_item_id,bucket);
  }
  const stateById=new Map(),questions=[];
  for(const [id,bucket] of groups) {
    const row=bucket[0];
    let state="UNDETERMINED";
    // Two different snapshots for the same ID must not create a review notice.
    const valid=row&&typeof row.title==="string"&&typeof row.status==="string"&&
      (row.metadata==null||typeof row.metadata==="object"&&!Array.isArray(row.metadata));
    if(valid&&bucket.every(x=>JSON.stringify(x)===JSON.stringify(row))) {
      if(["done","cancelled"].includes(row.status))state="INACTIVE";
      else if(row.status==="planned"&&!uncertainDate(row.metadata)) {
        const due=strictCalendarDate(row.due_on);
        if(due)state=due<today?"PAST_DATE_REVIEW":due===today?"DATE_TODAY":"FUTURE_DATE";
      }
    }
    stateById.set(id,state);
    if(state==="PAST_DATE_REVIEW")questions.push({
      key:"sys:date-review:plan:"+id,plan_item_id:id,question:NEUTRAL_DATE_TEXT
    });
  }
  questions.sort((a,b)=>a.plan_item_id-b.plan_item_id);
  return {stateById,questions,today};
}
function untilNextMoscowDate(now=new Date()) {
  const today=moscowCalendarDay(now),start=now.getTime();
  let lo=start,hi=start+48*3600*1000;
  if(moscowCalendarDay(new Date(hi))===today)throw new Error("No date boundary");
  while(hi-lo>1) {
    const mid=lo+Math.floor((hi-lo)/2);
    if(moscowCalendarDay(new Date(mid))===today)lo=mid;else hi=mid;
  }
  return hi-start;
}
function neutralDateNote() {
  return '<span class="neutral-date-note">'+esc(NEUTRAL_DATE_TEXT)+'</span>';
}
function neutralSystemQuestion(q,row) {
  return '<div class="neutral-date-question" data-system-question-key="'+esc(q.key)+'">'+
    '<p><strong>'+esc(q.question)+'</strong></p><p class="muted">'+
    esc(row?.title||"Пункт плана")+(row?.due_on?' · '+esc(fmtDate(row.due_on)):'')+' · <a href="#/future-plan">Будущий план</a>'+
    (row?.basis_record_id?' · '+recLink(row.basis_record_id):"")+'</p></div>';
}
let neutralMidnightTimer=null;
function cancelNeutralMidnight() {
  if(neutralMidnightTimer!==null)clearTimeout(neutralMidnightTimer);
  neutralMidnightTimer=null;
}
function neutralRoute() {
  const path=location.hash.replace(/^#\/?/,"").split(/[/?]/)[0];
  return ["","future-plan","visit-preparation","vaccination"].includes(path);
}
function scheduleNeutralMidnight() {
  cancelNeutralMidnight();
  if(app.classList.contains("hidden")||!neutralRoute())return;
  neutralMidnightTimer=setTimeout(()=>{
    neutralMidnightTimer=null;
    if(!app.classList.contains("hidden"))void route();
  },untilNextMoscowDate()+10);
}
function refreshVisibleDeadlines() {
  if(document.hidden||app.classList.contains("hidden")||!neutralRoute())return;
  void route(); // route increments the UI generation before any async read.
}


// Binding both authentication and asynchronous rendering to a session generation.
function isActiveUiGeneration(generation) {
  return generation === uiGeneration && !app.classList.contains("hidden");
}

const uniqueValues = (values) =>
  [...new Set((values || []).map(x => String(x ?? "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));

// Shorten only the visible column heading; preserve the full original
// heading in the sorting button's accessible name and in source records.
function formatTableHeader(label) {
  return String(label ?? "").replace(
    /(^|[^\p{L}])количество(?=$|[^\p{L}])/giu,
    "$1К-во"
  );
}

function sortableTable(headers, rows, { id, emptyLabel = "Пока нет данных" } = {}) {
  if (!rows?.length) return empty(emptyLabel);
  if (!id) throw new Error("sortableTable requires a stable id");

  const body = rows.map(rowSpec => {
    const spec = Array.isArray(rowSpec) ? { cells: rowSpec, attrs: {} } : rowSpec;
    const attrs = Object.entries(spec.attrs || {})
      .map(([key, value]) => `${esc(key)}="${esc(value)}"`)
      .join(" ");

    const cells = spec.cells.map(cellSpec => {
      const cell = typeof cellSpec === "object" && cellSpec !== null && "html" in cellSpec
        ? cellSpec
        : tableCell(esc(cellSpec), cellSpec);
      return `<td data-sort-value="${esc(cell.filterValue)}">${cell.html}</td>`;
    }).join("");

    return `<tr ${attrs}>${cells}</tr>`;
  }).join("");

  return `
    <div class="table-wrap">
      <table class="data-table sortable-table" id="${esc(id)}" data-sortable>
        <thead>
          <tr>
            ${headers.map((h, index) => `
              <th>
                <button type="button" class="sort-button" data-column="${index}" aria-label="Сортировать: ${esc(h)}">
                  <span>${esc(formatTableHeader(h))}</span><span class="sort-indicator" aria-hidden="true">↕</span>
                </button>
              </th>
            `).join("")}
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="table-count muted" id="${esc(id)}-count"></p>
  `;
}

function compareSortValues(a, b) {
  const normalizeDate = (value) => {
    const text = String(value ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
    const m = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
  };

  const av = String(a ?? "").trim();
  const bv = String(b ?? "").trim();
  const ad = normalizeDate(av);
  const bd = normalizeDate(bv);
  if (ad && bd) return ad.localeCompare(bd);

  const an = Number(av.replace(",", "."));
  const bn = Number(bv.replace(",", "."));
  if (av && bv && Number.isFinite(an) && Number.isFinite(bn)) return an - bn;

  return av.localeCompare(bv, "ru", { numeric: true, sensitivity: "base" });
}

function sortTable(table, column, button) {
  const sameColumn = Number(table.dataset.sortColumn) === column;
  const direction = sameColumn && table.dataset.sortDirection === "asc" ? "desc" : "asc";
  table.dataset.sortColumn = String(column);
  table.dataset.sortDirection = direction;

  const rows = [...table.tBodies[0].rows];
  rows.sort((a, b) => {
    const av = a.cells[column]?.dataset.sortValue || a.cells[column]?.textContent || "";
    const bv = b.cells[column]?.dataset.sortValue || b.cells[column]?.textContent || "";
    const cmp = compareSortValues(av, bv);
    return direction === "asc" ? cmp : -cmp;
  });
  rows.forEach(row => table.tBodies[0].appendChild(row));

  table.querySelectorAll(".sort-button").forEach(item => {
    const indicator = item.querySelector(".sort-indicator");
    const active = item === button;
    item.classList.toggle("active", active);
    if (indicator) indicator.textContent = active ? (direction === "asc" ? "↑" : "↓") : "↕";
  });
}

function updateTableCount(table) {
  if (!table) return;
  const rows = [...table.tBodies[0].rows];
  const visible = rows.filter(row => !row.hidden).length;
  const count = document.querySelector(`#${CSS.escape(table.id)}-count`);
  if (count) count.textContent = `Показано: ${visible} из ${rows.length}`;
}

// A table with overflow-x:auto cannot use CSS sticky <th> relative to the
// page viewport: the overflow wrapper becomes the sticky scroll container.
// A synchronized, fixed header copy provides both vertical pinning and normal
// horizontal scrolling without changing the source table or its sorting.
let pinnedHeaders = [];
let stickyFrame = 0;
let stickyChromeObserver = null;

function clearPinnedHeaders() {
  for (const entry of pinnedHeaders) entry.floating.remove();
  pinnedHeaders = [];
}

function stickyOffsets() {
  const topbar = document.querySelector(".topbar");
  const title = view.querySelector(":scope > h1");
  const filter = view.querySelector(".filter-bar[data-sticky-filter]");
  const headerHeight = Math.ceil(topbar?.getBoundingClientRect().height || 0);
  const titleHeight = Math.ceil(title?.getBoundingClientRect().height || 0);
  const filterHeight = Math.ceil(filter?.getBoundingClientRect().height || 0);
  return { headerHeight, titleHeight, filterHeight, tableTop: headerHeight + titleHeight + filterHeight };
}

function shouldPinTableHeader(head, wrapper, offset, viewportHeight) {
  return head.height > 0
    && head.bottom <= offset
    && wrapper.bottom > offset + head.height
    && wrapper.width > 0
    && offset + head.height < viewportHeight;
}

function updatePinnedHeaders() {
  const offset = stickyOffsets().tableTop;
  for (const entry of pinnedHeaders) {
    const { table, wrapper, floating, cloneTable } = entry;
    if (!wrapper.isConnected || !table.tHead) {
      floating.hidden = true;
      continue;
    }
    const rect = wrapper.getBoundingClientRect();
    const head = table.tHead.getBoundingClientRect();
    const show = shouldPinTableHeader(head, rect, offset, window.innerHeight);
    if (!show) {
      floating.hidden = true;
      continue;
    }
    const width = table.getBoundingClientRect().width;
    cloneTable.style.width = `${width}px`;
    cloneTable.style.minWidth = `${width}px`;
    const sourceCells = table.tHead.rows[0]?.cells || [];
    const cloneCells = cloneTable.tHead.rows[0]?.cells || [];
    for (let i = 0; i < sourceCells.length; i++) {
      const size = sourceCells[i].getBoundingClientRect().width;
      cloneCells[i].style.width = `${size}px`;
      cloneCells[i].style.minWidth = `${size}px`;
      cloneCells[i].style.maxWidth = `${size}px`;
      const originalIndicator = sourceCells[i].querySelector(".sort-indicator");
      const copyIndicator = cloneCells[i].querySelector(".sort-indicator");
      if (originalIndicator && copyIndicator) copyIndicator.textContent = originalIndicator.textContent;
      const originalButton = sourceCells[i].querySelector(".sort-button");
      const copyButton = cloneCells[i].querySelector(".sort-button");
      if (originalButton && copyButton) copyButton.classList.toggle("active", originalButton.classList.contains("active"));
    }
    floating.style.top = `${offset}px`;
    floating.style.left = `${rect.left}px`;
    floating.style.width = `${rect.width}px`;
    floating.style.height = `${head.height}px`;
    cloneTable.style.marginLeft = `${-wrapper.scrollLeft}px`;
    floating.hidden = false;
  }
}
function queuePinnedHeaderUpdate() {
  if (stickyFrame) return;
  stickyFrame = requestAnimationFrame(() => {
    stickyFrame = 0;
    updatePinnedHeaders();
  });
}
function setupStickyChrome() {
  stickyChromeObserver?.disconnect();
  const topbar = document.querySelector(".topbar");
  const title = view.querySelector(":scope > h1");
  const filter = view.querySelector(".filter-bar[data-sticky-filter]");
  const sync = () => {
    const { headerHeight, titleHeight } = stickyOffsets();
    document.documentElement.style.setProperty("--topbar-height", `${headerHeight}px`);
    document.documentElement.style.setProperty("--page-title-height", `${titleHeight}px`);
    queuePinnedHeaderUpdate();
  };
  if (typeof ResizeObserver !== "undefined") {
    stickyChromeObserver = new ResizeObserver(sync);
    for (const el of [topbar, title, filter]) if (el) stickyChromeObserver.observe(el);
  }
  sync();
}
function bindSortableTables() {
  document.querySelectorAll("table[data-sortable]").forEach(table => {
    table.querySelectorAll(".sort-button").forEach(button => {
      button.addEventListener("click", () => {
        sortTable(table, Number(button.dataset.column), button);
        queuePinnedHeaderUpdate();
      });
    });
    updateTableCount(table);
    const wrapper = table.closest(".table-wrap");
    if (!wrapper || !table.tHead) return;
    const floating = document.createElement("div");
    floating.className = "pinned-table-header";
    floating.hidden = true;
    const cloneTable = document.createElement("table");
    cloneTable.className = "data-table sortable-table";
    cloneTable.style.tableLayout = "fixed";
    cloneTable.appendChild(table.tHead.cloneNode(true));
    floating.appendChild(cloneTable);
    document.body.appendChild(floating);
    floating.addEventListener("click", event => {
      const copy = event.target.closest(".sort-button");
      if (!copy) return;
      const original = table.tHead.querySelector(`.sort-button[data-column="${copy.dataset.column}"]`);
      original?.click();
    });
    wrapper.addEventListener("scroll", queuePinnedHeaderUpdate, { passive: true });
    pinnedHeaders.push({ table, wrapper, floating, cloneTable });
  });
  queuePinnedHeaderUpdate();
}
window.addEventListener("scroll", queuePinnedHeaderUpdate, { passive: true });
window.addEventListener("resize", () => {
  const topbar = document.querySelector(".topbar");
  if (topbar && view.querySelector(":scope > h1")) setupStickyChrome();
});

const filterableTable = sortableTable;
const bindFilterableTables = bindSortableTables;

function compactSelect(label, id, values, allLabel = "Все") {
  const unique = uniqueValues(values);
  if (unique.length <= 1) return "";
  return `
    <label>
      ${esc(label)}
      <select id="${esc(id)}">
        <option value="">${esc(allLabel)}</option>
        ${unique.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join("")}
      </select>
    </label>
  `;
}

function bindAttributeFilters(tableId, specs) {
  const table = document.querySelector(`#${CSS.escape(tableId)}`);
  if (!table) return;

  const apply = () => {
    [...table.tBodies[0].rows].forEach(row => {
      row.hidden = specs.some(spec => {
        const control = document.querySelector(`#${CSS.escape(spec.id)}`);
        const wanted = normalizeFilter(control?.value || "");
        if (!wanted) return false;
        return normalizeFilter(row.dataset[spec.attr] || "") !== wanted;
      });
    });
    updateTableCount(table);
  };

  specs.forEach(spec => document.querySelector(`#${CSS.escape(spec.id)}`)?.addEventListener("change", apply));
  apply();
}

function renderActiveRecordTags() {
  const holder = document.querySelector("#records-active-tags");
  if (!holder) return;

  holder.innerHTML = [...recordTagFilters].map(tag => `
    <button type="button" class="active-filter-tag" data-remove-tag="${esc(tag)}" title="Убрать тег из фильтра">
      ${esc(tag)} ×
    </button>
  `).join("");

  holder.querySelectorAll("[data-remove-tag]").forEach(button => {
    button.addEventListener("click", () => {
      recordTagFilters.delete(button.dataset.removeTag);
      renderActiveRecordTags();
      applyRecordFilters();
    });
  });
}

function addRecordTagFilter(tag) {
  const value = String(tag || "").trim();
  if (!value) return;
  recordTagFilters.add(value);
  renderActiveRecordTags();
  applyRecordFilters();
}

function applyRecordFilters() {
  const table = document.querySelector("#records-index");
  if (!table) return;

  const dateFrom = document.querySelector("#records-date-from")?.value || "";
  const dateTo = document.querySelector("#records-date-to")?.value || "";
  const recordType = normalizeFilter(document.querySelector("#records-record-type")?.value || "");
  const confidence = normalizeFilter(document.querySelector("#records-confidence")?.value || "");

  [...table.tBodies[0].rows].forEach(row => {
    const rowDate = row.dataset.recordDate || "";
    const rowTags = (row.dataset.tags || "").split("||").filter(Boolean);
    const tagsOk = [...recordTagFilters].every(tag => rowTags.includes(normalizeFilter(tag)));
    const dateOk = (!dateFrom || !rowDate || rowDate >= dateFrom) && (!dateTo || !rowDate || rowDate <= dateTo);
    const typeOk = !recordType || normalizeFilter(row.dataset.recordType) === recordType;
    const confidenceOk = !confidence || normalizeFilter(row.dataset.confidence) === confidence;
    row.hidden = !(tagsOk && dateOk && typeOk && confidenceOk);
  });
  updateTableCount(table);
}

function setupRecordFilters(initialTags = []) {
  recordTagFilters.clear();
  initialTags.filter(Boolean).forEach(tag => recordTagFilters.add(tag));
  renderActiveRecordTags();

  ["#records-date-from", "#records-date-to"].forEach(id => {
    document.querySelector(id)?.addEventListener("input", applyRecordFilters);
  });
  ["#records-record-type", "#records-confidence"].forEach(id => {
    document.querySelector(id)?.addEventListener("change", applyRecordFilters);
  });

  const tagSelect = document.querySelector("#records-tag-filter");
  tagSelect?.addEventListener("change", () => {
    if (tagSelect.value) addRecordTagFilter(tagSelect.value);
    tagSelect.value = "";
  });

  document.querySelectorAll(".tag-filter-button").forEach(button => {
    button.addEventListener("click", () => addRecordTagFilter(button.dataset.tag));
  });

  applyRecordFilters();
}

async function assertReader(userId) {
  const { data, error } = await supabase
    .from("app_readers")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data?.user_id);
}

async function enterApp(session, generation) {
  if (generation !== uiGeneration) return;
  const allowed = await assertReader(session.user.id);
  // An old authorization must not revive the view after logout or a new login.
  if (generation !== uiGeneration) return;
  if (!allowed) {
    await supabase.auth.signOut();
    if (generation !== uiGeneration) return;
    throw new Error("Этот аккаунт не разрешён для HEALTH.");
  }
  showOnly(app);
  await route(generation);
}

async function boot() {
  // Never run getSession(), reader auth, or routes on an Auth callback.
  const isRecoveryCandidate = Boolean(location.search) ||
    (Boolean(location.hash) && !location.hash.startsWith("#/"));
  if (isRecoveryCandidate) {
    const fragment = location.hash;
    let scrubbed = false;
    try {
      history.replaceState(null, "", location.pathname);
      scrubbed = !location.search && !location.hash;
    } catch { /* no fallback that might leak the URL */ }
    if (scrubbed) void bootRecovery(fragment);
    else {
      ++uiGeneration;
      showOnly(loading);
    }
    return;
  }
  const generation = uiGeneration;
  const { data, error } = await supabase.auth.getSession();
  if (generation !== uiGeneration) return;
  if (error) {
    showOnly(login);
    loginError.textContent = error.message;
    return;
  }
  if (!data.session) {
    showOnly(login);
    return;
  }

  try {
    await enterApp(data.session, generation);
  } catch (error) {
    if (generation !== uiGeneration) return;
    showOnly(login);
    loginError.textContent = error.message || "Не удалось проверить доступ.";
  }
}

// The public recovery UI never fetches medical rows or calls the reader router.
let recoveryRequestPending = false;
let recoveryUpdatePending = false;

document.querySelector("#forgot-password").addEventListener("click", () => {
  ++uiGeneration;
  loginError.textContent = "";
  loginStatus.textContent = "";
  document.querySelector("#recovery-email").value = document.querySelector("#email").value.trim();
  document.querySelector("#recovery-send").disabled = false;
  document.querySelector("#recovery-request-status").textContent = "";
  showOnly(recoveryRequest);
  document.querySelector("#recovery-email").focus();
});

recoveryRequestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (recoveryRequestPending) return;
  const email = document.querySelector("#recovery-email").value.trim();
  if (!recoveryRequestForm.reportValidity()) return;
  recoveryRequestPending = true;
  const button = document.querySelector("#recovery-send");
  button.disabled = true;
  const status = document.querySelector("#recovery-request-status");
  status.textContent = "Отправляю запрос…";
  const generation = uiGeneration;
  try { await supabase.auth.requestPasswordRecovery(email); }
  finally {
    recoveryRequestPending = false;
    if (generation === uiGeneration && !recoveryRequest.classList.contains("hidden")) {
      // Same result for unknown addresses, throttling, and delivery failures:
      // no account enumeration from the public UI.
      status.textContent = "Если адрес зарегистрирован, письмо со ссылкой будет отправлено. Если письма нет, попробуйте позже.";
    }
  }
});

document.querySelector("#recovery-request-back").addEventListener("click", () => {
  ++uiGeneration;
  showOnly(login);
  loginStatus.textContent = "";
});

recoveryResetForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (recoveryUpdatePending || !recoveryResetForm.reportValidity()) return;
  const first = document.querySelector("#recovery-password");
  const confirm = document.querySelector("#recovery-password-confirm");
  const status = document.querySelector("#recovery-reset-status");
  if (first.value !== confirm.value) {
    status.textContent = "Пароли не совпадают.";
    return;
  }
  recoveryUpdatePending = true;
  const button = document.querySelector("#recovery-save");
  button.disabled = true;
  status.textContent = "Сохраняю…";
  const generation = uiGeneration;
  let result;
  try { result = await supabase.auth.finishPasswordRecovery(first.value); }
  catch { result = { error: new Error("Не удалось подтвердить изменение пароля.") }; }
  finally {
    first.value = "";
    confirm.value = "";
    recoveryUpdatePending = false;
  }
  if (generation !== uiGeneration) return;
  if (result.error || !result.updated) {
    showOnly(recoveryRequest);
    document.querySelector("#recovery-request-status").textContent =
      "Не удалось подтвердить смену пароля. Для новой попытки запросите другое письмо.";
    document.querySelector("#recovery-send").disabled = false;
    return;
  }
  showOnly(login);
  loginStatus.textContent = result.logoutConfirmed
    ? "Пароль изменён. Войдите с новым паролем."
    : "Пароль изменён. Серверное завершение recovery-сессии не подтверждено. Войдите заново.";
});

document.querySelector("#recovery-reset-back").addEventListener("click", () => {
  ++uiGeneration;
  document.querySelector("#recovery-password").value = "";
  document.querySelector("#recovery-password-confirm").value = "";
  showOnly(login);
  void supabase.auth.cancelPasswordRecovery();
});

async function bootRecovery(fragment) {
  ++uiGeneration;
  const generation = uiGeneration;
  view.replaceChildren();
  showOnly(loading);
  const result = await supabase.auth.beginPasswordRecovery(fragment);
  if (generation !== uiGeneration) return;
  if (result.error) {
    showOnly(recoveryRequest);
    document.querySelector("#recovery-request-status").textContent =
      "Ссылка восстановления недействительна или истекла. Запросите новое письмо.";
    return;
  }
  document.querySelector("#recovery-reset-status").textContent = "";
  document.querySelector("#recovery-save").disabled = false;
  showOnly(recoveryReset);
  document.querySelector("#recovery-password").focus();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const generation = ++uiGeneration;
  loginError.textContent = "";
  const email = document.querySelector("#email").value.trim();
  const password = document.querySelector("#password").value;

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (generation !== uiGeneration) return;
  if (error) {
    loginError.textContent = "Не удалось войти.";
    return;
  }

  try {
    await enterApp(data.session, generation);
  } catch (err) {
    if (generation !== uiGeneration) return;
    loginError.textContent = err.message || "Доступ запрещён.";
    showOnly(login);
  }
});

function clearMedicalUi() {
  cancelNeutralMidnight();
  uiGeneration += 1;
  showOnly(login);
  view.replaceChildren();
  recordTagFilters.clear();
  clearPinnedHeaders();
  const password = document.querySelector("#password");
  if (password) password.value = "";
  loginError.textContent = "";
  location.hash = "#/";
}

logoutButton.addEventListener("click", async () => {
  // Wipe the medical screen before any potentially stalled network request.
  clearMedicalUi();
  const generation = uiGeneration;
  try {
    const { error } = await supabase.auth.signOut();
    if (error && generation === uiGeneration) {
      loginError.textContent = "Выход выполнен в этой вкладке. Серверный выход или очистка хранилища не подтверждены.";
    }
  } catch {
    if (generation === uiGeneration) {
      loginError.textContent = "Выход выполнен в этой вкладке. Серверный выход или очистка хранилища не подтверждены.";
    }
  }
});

// Any cross-tab change of the shared Auth session invalidates the visible
// medical view, including a replacement with a different *nonempty* token.
// This hides the UI without pretending that the replacement is a logout.
// Same-user refreshes may require re-entry: deliberate fail-closed tradeoff.
window.addEventListener("storage", (event) => {
  if (event.storageArea && event.storageArea !== localStorage) return;
  if (!(event.key === null && event.storageArea === localStorage) &&
      (event.key !== "health.session.v1" || event.newValue === event.oldValue)) return;
  // Cross-tab UI and auth generation are already invalidated by the existing guards.
  clearMedicalUi();
  if (event.newValue) {
    loginError.textContent = "Сессия изменилась в другой вкладке. Подтвердите вход повторно.";
  }
});

const mobileMenu = document.querySelector("#primary-nav");
const menuToggle = document.querySelector("#menu-toggle");

function closeMobileMenu() {
  mobileMenu?.classList.remove("is-open");
  menuToggle?.setAttribute("aria-expanded", "false");
  menuToggle?.setAttribute("aria-label", "Открыть меню");
}
menuToggle?.addEventListener("click", () => {
  const opened = mobileMenu.classList.toggle("is-open");
  menuToggle.setAttribute("aria-expanded", String(opened));
  menuToggle.setAttribute("aria-label", opened ? "Закрыть меню" : "Открыть меню");
});
mobileMenu?.addEventListener("click", event => {
  if (event.target.closest("a")) closeMobileMenu();
});
window.addEventListener("hashchange", () => {
  closeMobileMenu();
  if (!app.classList.contains("hidden")) route();
});
window.addEventListener("focus", refreshVisibleDeadlines);
window.addEventListener("pageshow", refreshVisibleDeadlines);
document.addEventListener("visibilitychange", refreshVisibleDeadlines);

async function route(generation = ++uiGeneration) {
  if (!isActiveUiGeneration(generation)) return;
  clearPinnedHeaders();
  const raw = location.hash.startsWith("#/") ? location.hash.slice(2) : location.hash.replace(/^#/, "");
  const [pathPart, queryString = ""] = raw.split("?");
  const parts = pathPart.split("/").filter(Boolean);
  const params = new URLSearchParams(queryString);
  view.innerHTML = '<p class="muted">Загрузка…</p>';

  try {
    if (parts.length === 0) {
      await renderCurrentState("all", generation);
    } else if (["chronic", "open-cases", "medications", "visit-preparation", "future-plan"].includes(parts[0])) {
      await renderCurrentState(parts[0], generation);
    } else if (parts[0] === "vaccination") {
      await renderVaccination(generation);
    } else if (parts[0] === "closed-cases") {
      await renderClosedCases(generation);
    } else if (parts[0] === "cases" && parts[1]) {
      await renderCase(decodeURIComponent(parts[1]), generation);
    } else if (parts[0] === "records" && parts.length === 1) {
      await renderRecords({ initialTags: params.getAll("tag") }, generation);
    } else if (parts[0] === "records" && parts[1]) {
      await renderRecord(decodeURIComponent(parts[1]), generation);
    } else {
      view.innerHTML = "<h1>Не найдено</h1>";
    }
  } catch (error) {
    if (!isActiveUiGeneration(generation)) return;
    console.error(error);
    view.innerHTML = '<h1>Ошибка</h1><p class="error">Не удалось загрузить данные.</p>';
  }
  if (!isActiveUiGeneration(generation)) return;
  setupStickyChrome();
  scheduleNeutralMidnight();
}

async function fetchCaseBundles(cases) {
  if (!cases?.length) return [];

  const caseKeys = cases.map(x => x.case_key);
  const { data: links, error: linksError } = await supabase
    .from("case_links")
    .select("case_key,record_id,relation,relation_date,note")
    .in("case_key", caseKeys)
    .order("relation_date", { ascending: true, nullsFirst: true });

  if (linksError) throw linksError;

  const recordIds = [...new Set([
    ...cases.flatMap(x => [x.opening_record_id, x.closing_record_id].filter(Boolean)),
    ...(links || []).map(x => x.record_id)
  ])];

  let records = [];
  if (recordIds.length) {
    const result = await supabase
      .from("records")
      .select("record_id,record_date,title,summary,body_text")
      .in("record_id", recordIds);
    if (result.error) throw result.error;
    records = result.data || [];
  }

  const recordMap = new Map(records.map(r => [r.record_id, r]));
  const linksByCase = new Map();
  for (const link of links || []) {
    const bucket = linksByCase.get(link.case_key) || [];
    bucket.push(link);
    linksByCase.set(link.case_key, bucket);
  }

  return cases.map(c => ({
    ...c,
    links: linksByCase.get(c.case_key) || [],
    opening_record: recordMap.get(c.opening_record_id) || null,
    closing_record: c.closing_record_id ? recordMap.get(c.closing_record_id) || null : null,
    record_map: recordMap
  }));
}

function caseDetails(item, { closed = false, open = false } = {}) {
  const startDate = item.opening_record?.record_date || item.metadata?.start_date || "";
  const endDate = item.closing_record?.record_date || item.metadata?.end_date || "";
  const linked = item.links.map(link => {
    const r = item.record_map.get(link.record_id);
    const date = link.relation_date || r?.record_date || "";
    return `
      <li>
        <span class="relation">${esc(link.relation)}</span>
        ${recLink(link.record_id, r ? recordDisplayTitle(r) : link.record_id)}
        ${date ? `<span class="muted"> · ${esc(fmtDate(date))}</span>` : ""}
        ${r?.title ? `<span> · ${esc(r.title)}</span>` : ""}
        ${link.note ? `<p class="muted">${esc(link.note)}</p>` : ""}
      </li>
    `;
  }).join("");

  const dateSuffix = closed && endDate ? ` <span class="summary-date">· закрыт ${esc(fmtDate(endDate))}</span>` : "";

  return `
    <details class="case-card" data-category="${esc(item.category || "")}" data-end-date="${esc(item.closing_record?.record_date || item.metadata?.end_date || "")}" ${open ? "open" : ""}>
      <summary><strong>${esc(item.title)}</strong>${dateSuffix}</summary>
      <div class="case-body">
        ${item.summary ? `<p class="lead-small">${esc(item.summary)}</p>` : ""}
        <dl class="meta-list">
          <dt>Категория</dt><dd>${esc(item.category === "chronic" ? "Хроническое состояние" : "Случай / эпизод")}</dd>
          <dt>Начало</dt><dd>${esc(fmtDate(startDate))}</dd>
          ${closed ? `<dt>Закрыт</dt><dd>${esc(fmtDate(endDate))}</dd>` : ""}
          <dt>Открывающая REC</dt><dd>${recLink(item.opening_record_id)}</dd>
          ${item.closing_record_id ? `<dt>Закрывающая REC</dt><dd>${recLink(item.closing_record_id)}</dd>` : ""}
        </dl>
        <h3>Все REC</h3>
        ${linked ? `<ul class="rec-links">${linked}</ul>` : empty("Связанные REC пока не импортированы")}
      </div>
    </details>
  `;
}


function questionDetails(item) {
  const meta = item.metadata || {};
  const created = meta.created_date || "";
  const note = meta.note || "";
  const related = Array.isArray(meta.source_record_ids) ? meta.source_record_ids : [];

  return `
    <details class="case-card question-card">
      <summary><strong>${esc(item.question)}</strong></summary>
      <div class="case-body">
        <dl class="meta-list">
          <dt>Статус</dt><dd>Открыт</dd>
          ${created ? `<dt>Создан</dt><dd>${esc(created)}</dd>` : ""}
          ${item.basis_record_id ? `<dt>Основание REC</dt><dd>${recLink(item.basis_record_id)}</dd>` : ""}
        </dl>
        ${note ? `<p class="lead-small">${esc(note)}</p>` : ""}
        ${related.length ? `
          <h3>Связанные REC</h3>
          <p class="rec-inline">${related.map(id => recLink(id)).join(", ")}</p>
        ` : ""}
      </div>
    </details>
  `;
}


const specialtyLabels = [
  ["эндокринолог", "эндокринологу"],
  ["кардиолог", "кардиологу"],
  ["терапевт", "терапевту"],
  ["лор", "лору"],
  ["отоларинголог", "лору"],
  ["хирург", "хирургу"],
  ["ортопед", "ортопеду"],
  ["гастроэнтеролог", "гастроэнтерологу"],
  ["невролог", "неврологу"],
  ["инфекционист", "инфекционисту"],
  ["стоматолог", "стоматологу"],
  ["уролог", "урологу"],
  ["психиатр", "психиатру"],
  ["дерматолог", "дерматологу"],
  ["ревматолог", "ревматологу"],
  ["аллерголог", "аллергологу"],
  ["онколог", "онкологу"],
  ["гинеколог", "гинекологу"],
  ["колопроктолог", "колопроктологу"],
  ["косметолог", "косметологу"]
];
const visitLabel = specialty => specialtyLabels.find(x => x[0] === specialty)?.[1] || "специалисту";

// Only an explicit specialist prefix in a question or an explicit visit plan
// is sufficient. Do not infer specialty from the medical history or drug names.
function namedSpecialties(text) {
  const value = String(text || "").toLocaleLowerCase("ru");
  const found = specialtyLabels.filter(([stem]) => value.includes(stem)).map(([stem]) =>
    stem === "отоларинголог" ? "лор" : stem
  );
  return [...new Set(found)];
}
// Classify a visit from its explicit plan heading (not the clinical details).
// A named specialist clinic also identifies its visit type.
function plannedVisitSpecialties(item) {
  const meta = item.metadata || {};
  const explicit = Array.isArray(meta.visit_specialties)
    ? meta.visit_specialties.map(value => String(value).toLocaleLowerCase("ru"))
        .filter(value => specialtyLabels.some(([stem]) => stem === value))
    : [];
  if (explicit.length) return [...new Set(explicit)];
  const heading = String(item.title || "").split(/[;:]/)[0].slice(0, 140).trim();
  if (/^при[её]м\s+в\s+спид[-\s]?центр/iu.test(heading)) return ["инфекционист"];
  if (/^стоматолог[-\s]хирург/iu.test(heading)) return ["стоматолог"];
  return namedSpecialties(heading);
}
function questionSpecialties(question) {
  const meta = question.metadata || {};
  if (Array.isArray(meta.visit_specialties) && meta.visit_specialties.length) {
    return meta.visit_specialties.map(x => String(x).toLocaleLowerCase("ru"))
      .filter(x => specialtyLabels.some(([stem]) => stem === x));
  }
  const prefix = String(question.question || "").split(":")[0];
  if (prefix.length <= 95) {
    const named = namedSpecialties(prefix);
    if (named.length) return named;
  }
  // A question without a named addressee may explicitly name the specialist
  // in its recorded note. Do not infer specialty from symptoms or history.
  const noteHeading = String(meta.note || "").split(/[.;]/)[0].trim();
  if (/^вопрос к (?:будущему |плановому )?при[её]му/iu.test(noteHeading)) {
    return namedSpecialties(noteHeading);
  }
  return [];
}
function isMedicalCardQuestion(question) {
  return ["medical_card", "chart"].includes(question.metadata?.category)
    || question.metadata?.purpose === "medical_card";
}
function visitPreparation(planItems, questions) {
  const plannedGroups = [];
  const unmatchedGroups = new Map();
  for (const item of planItems || []) {
    const kind = String(item.metadata?.kind || "").toLocaleLowerCase("ru");
    if (!kind.includes("визит") && !kind.includes("консультаци")) continue;
    const specialties = plannedVisitSpecialties(item);
    const dentalSurgeon = /^стоматолог[-\s]хирург/iu.test(String(item.title || ""));
    plannedGroups.push({
      specialty: specialties,
      title: dentalSurgeon ? "Визит к стоматологу-хирургу"
        : specialties.length ? `Визит к ${specialties.map(visitLabel).join(" и ")}` : "Визит к специалисту",
      visits: [item], questions: [], planItemId: item.plan_item_id
    });
  }
  const unmatched = specialty => {
    if (!unmatchedGroups.has(specialty)) {
      unmatchedGroups.set(specialty, {
        specialty: [specialty],
        title: specialty === "специалист"
          ? "Вопросы к специалисту — специальность не указана"
          : `Вопросы к ${visitLabel(specialty)} — визит не запланирован`,
        visits: [], questions: []
      });
    }
    return unmatchedGroups.get(specialty);
  };
  for (const question of questions || []) {
    if (isMedicalCardQuestion(question)) continue;
    const specialties = questionSpecialties(question);
    if (!specialties.length) {
      unmatched("специалист").questions.push(question);
      continue;
    }
    // A question can belong to more than one explicit planned visit.
    // Show it only once within each visit, even if two specialties match.
    const matched = new Set();
    for (const specialty of specialties) {
      let found = false;
      for (const group of plannedGroups) {
        if (!group.specialty.includes(specialty)) continue;
        if (!matched.has(group)) {
          group.questions.push(question);
          matched.add(group);
        }
        found = true;
      }
      if (!found) unmatched(specialty).questions.push(question);
    }
  }
  const all = [...plannedGroups, ...unmatchedGroups.values()];
  if (!all.length) return empty("Плановых визитов и вопросов специалистам пока нет");
  return all.map(group => {
    const planNotes = group.visits.map(item => {
      const due = item.metadata?.due_text || fmtDate(item.due_on) || "Срок не указан";
      return `<li><strong>${esc(due)}</strong> · ${esc(item.title)}
        ${item.basis_record_id ? ` · ${recLink(item.basis_record_id)}` : ""}</li>`;
    }).join("");
    return `
      <details class="case-card visit-card" ${group.planItemId ? `data-plan-id="${esc(group.planItemId)}"` : ""}>
        <summary><strong>${esc(group.title)}</strong></summary>
        <div class="case-body">
          ${planNotes ? `<h3>Плановый визит</h3><ul class="record-list">${planNotes}</ul>` :
            '<p class="muted">Связанный пункт будущего плана пока не найден</p>'}
          <h3>Вопросы к специалисту</h3>
          ${group.questions.length ? group.questions.map(questionDetails).join("") :
            empty("Вопросы пока не добавлены")}
        </div>
      </details>`;
  }).join("");
}

// The current medication's evidence can be in metadata even when the legacy
// basis_record_id column is NULL. Link only the newest existing dated REC.
function medicationRecordIds(medication) {
  const sources = Array.isArray(medication.metadata?.source_record_ids)
    ? medication.metadata.source_record_ids : [];
  return [...new Set([...sources, medication.basis_record_id]
    .filter(id => typeof id === "string" && /^REC-\d{8}-\d{3}$/.test(id)))];
}
function latestMedicationRecordId(medication, recordDates) {
  return medicationRecordIds(medication)
    .filter(id => recordDates.has(id))
    .reduce((latest, id) => {
      if (!latest) return id;
      return String(recordDates.get(id) || "").localeCompare(String(recordDates.get(latest) || "")) >= 0
        ? id : latest;
    }, "");
}
function medicationHistoriesForRecord(recordId, medications) {
  return (medications || []).flatMap(medication => {
    const ids = medicationRecordIds(medication);
    return ids.includes(recordId) && ids.length > 1
      ? [{ name: medication.name, recordIds: ids.filter(id => id !== recordId) }]
      : [];
  });
}
async function medicationHistorySection(recordId) {
  const { data: medications, error } = await supabase.from("medications")
    .select("name,basis_record_id,metadata").eq("status", "active");
  // History links are optional: do not hide the actual REC when they cannot load.
  if (error) return "";
  const histories = medicationHistoriesForRecord(recordId, medications);
  if (!histories.length) return "";
  const otherIds = [...new Set(histories.flatMap(item => item.recordIds))];
  const { data: relatedRecords, error: recordsError } = await supabase.from("records")
    .select("record_id,record_date").in("record_id", otherIds);
  if (recordsError) return "";
  const dates = new Map((relatedRecords || []).map(item => [item.record_id, item.record_date]));
  const blocks = histories.map(item => {
    const ids = item.recordIds.filter(id => dates.has(id))
      .sort((a, b) => String(dates.get(b) || "").localeCompare(String(dates.get(a) || "")));
    if (!ids.length) return "";
    return `<h3>${esc(item.name)}</h3><ul class="record-list">${ids.map(id =>
      `<li>${recLink(id)} · ${esc(fmtDate(dates.get(id)))}</li>`
    ).join("")}</ul>`;
  }).filter(Boolean);
  if (!blocks.length) return "";
  return `<section><h2>Другие связанные REC по препаратам</h2>${blocks.join("")}</section>`;
}
// Vaccination is a read-only projection: REC administration evidence and plan
// evidence remain distinct. Unknown stages and vaccine brands are not guessed.
function vaccinationRecCell(item) {
  const links = [];
  if (item.appointmentRecordId) {
    links.push('<span>Назн.: ' + recLink(item.appointmentRecordId) + '</span>');
  }
  if (item.basisRecordId
      && item.basisRecordId !== item.appointmentRecordId
      && item.basisRecordId !== item.administrationRecordId) {
    links.push('<span title="Основание REC">' + recLink(item.basisRecordId) + '</span>');
  }
  if (item.administrationRecordId) {
    links.push('<span title="Запись о проведении">' + recLink(item.administrationRecordId) + '</span>');
  }
  return links.length ? '<span class="rec-inline">' + links.join('') + '</span>' : '—';
}

function vaccinationControl(item, section, neutralById = new Map()) {
  const note = p => p?.kind === "plan" && neutralById.get(Number(String(p.id).replace(/^plan:/,""))) === "PAST_DATE_REVIEW" ? neutralDateNote() : "";
  if (section === "latest") {
    if (!item.next) return "—";
    const next = item.next;
    const due = next.date ? fmtDate(next.date) : next.dateText || "срок не определён";
    return '<span class="vaccination-control">' +
      esc(next.stage === "—" ? "Следующий этап" : next.stage) + ' · ' + esc(due) +
      note(next) +
      '</span>';
  }
  return esc(item.sourceStatus || "—") + note(item);
}

// Presentation only: several infection labels in a REC do not establish
// whether this was one injection or several administrations.
function vaccinationInfectionCell(item, section) {
  const label = '<strong>' + esc(item.infection) + '</strong>';
  if (section !== "history" || item.kind !== "actual" ||
      !Array.isArray(item.keys) || item.keys.length < 2) return label;
  const names = String(item.infection || "").split(",")
    .map(name => name.trim()).filter(Boolean);
  if (names.length < 2) return label;
  return '<details class="vaccination-multi-infection"><summary>' + label +
    ' <span class="vaccination-multi-note">Инфекции в записи</span></summary>' +
    '<ul class="vaccination-component-list" aria-label="Инфекции, указанные в записи">' +
    names.map(name => '<li><span class="vaccination-component-tag">' + esc(name) +
      '</span></li>').join("") + '</ul></details>';
}

function vaccinationRows(items, section, neutralById = new Map()) {
  return items.map(item => {
    const dateText = item.date ? fmtDate(item.date) : item.dateText || "—";
    const status = section === "latest" ? "Проведена" : item.sourceStatus || "—";
    return {
      attrs: { "data-status": status },
      cells: [
        tableCell(vaccinationInfectionCell(item, section), item.infection),
        tableCell(esc(item.stage), item.stage),
        tableCell(esc(dateText), item.date || dateText),
        tableCell(esc(item.vaccine || "—"), item.vaccine || ""),
        tableCell(vaccinationControl(item,section,neutralById), status),
        tableCell(vaccinationRecCell(item), [
          item.appointmentRecordId,item.basisRecordId,item.administrationRecordId
        ].filter(Boolean).join(" "))
      ]
    };
  });
}

async function renderVaccination(generation) {
  const [records, plan] = await Promise.all([
    supabase.from("records")
      .select("record_id,record_date,title,summary,body_text,status,tags,metadata")
      .contains("tags",["VACCINATION"])
      .order("record_date",{ascending:false}),
    supabase.from("plan_items")
      .select("plan_item_id,title,due_on,status,basis_record_id,metadata,updated_at")
      .order("due_on",{ascending:true,nullsFirst:false})
  ]);
  if (records.error) throw records.error;
  if (plan.error) throw plan.error;
  const vaccine = buildVaccinationView(records.data || [], plan.data || []);
  const neutral = projectNeutralDates(plan.data || []);
  const headers = ["Инфекция(и)","Этап","Дата","Вакцина","Контроль","REC"];
  const statuses = uniqueValues(vaccine.history.map(item => item.sourceStatus));
  if (!isActiveUiGeneration(generation)) return;
  view.innerHTML = [
    '<h1>Вакцинация</h1>',
    '<section><h2>Последние проведённые вакцинации</h2>',
    filterableTable(headers, vaccinationRows(vaccine.latest,"latest",neutral.stateById), {
      id:"vaccination-latest", emptyLabel:"Подтверждённых введений в REC не найдено"
    }), '</section>',
    '<section><h2>Запланированные вакцинации</h2>',
    filterableTable(headers, vaccinationRows(vaccine.planned,"planned",neutral.stateById), {
      id:"vaccination-planned", emptyLabel:"Активных пунктов вакцинации в плане нет"
    }), '</section>',
    '<section><h2>Все вакцинации</h2>',
    statuses.length > 1 ? '<div class="filter-bar" aria-label="Фильтр истории вакцинаций">' +
      compactSelect("Статус","vaccination-history-status",statuses) + '</div>' : '',
    filterableTable(headers, vaccinationRows(vaccine.history,"history",neutral.stateById), {
      id:"vaccination-history", emptyLabel:"Сведений о вакцинации пока нет"
    }), '</section>'
  ].join("\n");
  bindFilterableTables();
  bindAttributeFilters("vaccination-history", [{id:"vaccination-history-status",attr:"status"}]);
}

async function renderCurrentState(mode = "all", generation) {
  const [cases, meds, plan, questions] = await Promise.all([
    supabase.from("cases").select("case_key,title,summary,status,category,opening_record_id,closing_record_id,metadata").eq("status","open").order("title"),
    supabase.from("medications").select("medication_id,name,dose,schedule,status,basis_record_id,metadata").eq("status","active").order("name"),
    supabase.from("plan_items").select("plan_item_id,title,due_on,status,basis_record_id,metadata,updated_at").eq("status","planned").order("due_on",{ascending:true,nullsFirst:false}),
    supabase.from("questions").select("question_id,question,status,basis_record_id,metadata").eq("status","open").order("question_id")
  ]);

  for (const result of [cases, meds, plan, questions]) {
    if (result.error) throw result.error;
  }

  const allMedicationRecordIds = [...new Set((meds.data || []).flatMap(medicationRecordIds))];
  let medicationRecordDates = new Map();
  if (allMedicationRecordIds.length) {
    const { data: medicationRecords, error: recordsError } = await supabase
      .from("records").select("record_id,record_date").in("record_id", allMedicationRecordIds);
    if (recordsError) throw recordsError;
    medicationRecordDates = new Map((medicationRecords || [])
      .map(record => [record.record_id, record.record_date]));
  }

  const bundled = await fetchCaseBundles(cases.data || []);
  const medicalQuestions = (questions.data || []).filter(isMedicalCardQuestion);
  const neutral = projectNeutralDates(plan.data || []);
  const planById = new Map((plan.data || []).map(x => [x.plan_item_id, x]));
  const chronic = bundled.filter(x => x.category === "chronic");
  const episodes = bundled.filter(x => x.category !== "chronic");

  const medsRows = (meds.data || []).map(x => {
    const currentRecordId = latestMedicationRecordId(x, medicationRecordDates);
    return [
      tableCell(`<strong>${esc(x.name)}</strong>`, x.name),
      tableCell(esc(x.dose || ""), x.dose || ""),
      tableCell(esc(x.schedule || ""), x.schedule || ""),
      tableCell(currentRecordId ? recLink(currentRecordId) : "", currentRecordId)
    ];
  });

  const planRows = (plan.data || []).map(x => {
    const due = x.metadata?.due_text || fmtDate(x.due_on) || "";
    const kind = x.metadata?.kind || "";
    const status = neutralPlanSourceStatus(x.metadata?.source_status, "запланировано");
    const note = neutral.stateById.get(x.plan_item_id)==="PAST_DATE_REVIEW"?neutralDateNote():"";
    return {
      attrs: { "data-kind": kind, "data-status": status },
      cells: [
        tableCell(esc(due), due),
        tableCell(esc(kind), kind),
        tableCell(esc(x.title), x.title),
        tableCell(esc(status)+note, status),
        tableCell(x.basis_record_id ? recLink(x.basis_record_id) : "", x.basis_record_id || "")
      ]
    };
  });
  const planKinds = uniqueValues((plan.data || []).map(x => x.metadata?.kind || ""));
  const planStatuses = uniqueValues((plan.data || []).map(x =>
    neutralPlanSourceStatus(x.metadata?.source_status, "запланировано")));


  const sections = {
    "medical-card": `<section><h2>Вопросы по медкарте</h2>
      ${medicalQuestions.length || neutral.questions.length ? [...medicalQuestions.map(questionDetails), ...neutral.questions.map(q => neutralSystemQuestion(q,planById.get(q.plan_item_id)))].join("") : empty("Открытых вопросов по медкарте нет")}
    </section>`,
    "chronic": `<section>${mode === "all" ? "<h2>Хронические состояния</h2>" : ""}
      ${chronic.length ? chronic.map(x => caseDetails(x)).join("") : empty()}
    </section>`,
    "open-cases": `<section>${mode === "all" ? "<h2>Открытые случаи</h2>" : ""}
      ${episodes.length ? episodes.map(x => caseDetails(x)).join("") : empty()}
    </section>`,
    "medications": `<section>${mode === "all" ? "<h2>Принимаемые препараты</h2>" : ""}
      ${filterableTable(["Препарат","Дозировка","Режим","REC"], medsRows, { id: "medications-table" })}
    </section>`,
    "visit-preparation": `<section>${mode === "all" ? "<h2>Подготовка к визиту</h2>" : ""}
      ${visitPreparation(plan.data || [], questions.data || [])}
    </section>`,
    "future-plan": `<section>${mode === "all" ? "<h2>Будущий план</h2>" : ""}
      ${planKinds.length > 1 || planStatuses.length > 1 ? `
        <div class="filter-bar" ${mode === "future-plan" ? "data-sticky-filter" : ""} aria-label="Фильтр будущего плана">
          ${compactSelect("Вид", "plan-kind-filter", planKinds)}
          ${compactSelect("Статус", "plan-status-filter", planStatuses)}
        </div>
      ` : ""}
      ${filterableTable(["Срок или условие","Вид","Действие","Статус","REC"], planRows, { id: "future-plan-table" })}
    </section>`
  };
  const sectionNames = {
    "chronic": "Хронические состояния",
    "open-cases": "Открытые случаи",
    "medications": "Принимаемые препараты",
    "visit-preparation": "Подготовка к визиту",
    "future-plan": "Будущий план"
  };
  const content = mode === "all"
    ? ["medical-card", "chronic", "open-cases", "medications", "visit-preparation", "future-plan"]
      .map(name => sections[name]).join("\n")
    : sections[mode] || empty();
  if (!isActiveUiGeneration(generation)) return;
  view.innerHTML = `
    <h1>${esc(sectionNames[mode] || "Текущее состояние")}</h1>
    ${content}
  `;
  bindFilterableTables();
  bindAttributeFilters("future-plan-table", [
    { id: "plan-kind-filter", attr: "kind" },
    { id: "plan-status-filter", attr: "status" }
  ]);
}

async function renderClosedCases(generation) {
  const { data, error } = await supabase
    .from("cases")
    .select("case_key,title,summary,status,category,opening_record_id,closing_record_id,metadata")
    .eq("status","closed")
    .order("title");

  if (error) throw error;

  const bundled = await fetchCaseBundles(data || []);
  bundled.sort((a, b) => {
    const ad = a.closing_record?.record_date || a.metadata?.end_date || "";
    const bd = b.closing_record?.record_date || b.metadata?.end_date || "";
    return bd.localeCompare(ad);
  });

  if (!isActiveUiGeneration(generation)) return;
  view.innerHTML = `
    <h1>Закрытые случаи</h1>
    <section class="case-stack" id="closed-case-list">
      ${bundled.length ? bundled.map(x => caseDetails(x, { closed: true })).join("") : empty("Закрытых случаев пока нет")}
    </section>
  `;
}

async function renderCase(caseKey, generation) {
  const { data, error } = await supabase
    .from("cases")
    .select("case_key,title,summary,status,category,opening_record_id,closing_record_id,metadata")
    .eq("case_key", caseKey)
    .single();

  if (error) throw error;

  const [item] = await fetchCaseBundles([data]);
  const backHref = item.status === "closed" ? "#/closed-cases" : "#/";
  const backLabel = item.status === "closed" ? "Закрытые случаи" : "Текущее состояние";

  const rows = item.links.map(link => {
    const r = item.record_map.get(link.record_id);
    const date = fmtDate(link.relation_date || r?.record_date || "");
    return [
      tableCell(`<span class="relation">${esc(link.relation)}</span>`, link.relation),
      tableCell(esc(date), date),
      tableCell(recLink(link.record_id), link.record_id),
      tableCell(esc(r ? recordDisplayTitle(r) : ""), r ? recordDisplayTitle(r) : "")
    ];
  });

  if (!isActiveUiGeneration(generation)) return;
  view.innerHTML = `
    <p><a href="${backHref}">← ${esc(backLabel)}</a></p>
    <h1>${esc(item.title)}</h1>
    <p class="status-line">${chips([
      item.category === "chronic" ? "Хроническое состояние" : "Случай / эпизод",
      item.status === "closed" ? "Закрыт" : "Открыт"
    ])}</p>
    ${item.summary ? `<p class="lead">${esc(item.summary)}</p>` : ""}
    <dl>
      <dt>ID случая</dt><dd class="mono">${esc(item.case_key)}</dd>
      <dt>Начало</dt><dd>${esc(fmtDate(item.opening_record?.record_date || item.metadata?.start_date || ""))} · ${recLink(item.opening_record_id)}</dd>
      ${item.closing_record_id ? `<dt>Закрытие</dt><dd>${esc(fmtDate(item.closing_record?.record_date || item.metadata?.end_date || ""))} · ${recLink(item.closing_record_id)}</dd>` : ""}
    </dl>
    <section>
      <h2>Хронология REC</h2>
      ${filterableTable(["Связь","Дата","REC","Запись"], rows, { id: "case-chronology-table" })}
    </section>
  `;
  bindFilterableTables();
}

async function renderRecords({ initialTags = [] } = {}, generation) {
  const [{ data: records, error: recordsError }, { data: links, error: linksError }, { data: cases, error: casesError }] = await Promise.all([
    supabase
      .from("records")
      .select("record_id,record_date,title,type,record_type,confidence,status,tags,summary")
      .order("record_date", { ascending: false })
      .limit(500),
    supabase
      .from("case_links")
      .select("case_key,record_id,relation"),
    supabase
      .from("cases")
      .select("case_key,title,status")
  ]);

  if (recordsError) throw recordsError;
  if (linksError) throw linksError;
  if (casesError) throw casesError;

  const caseMap = new Map((cases || []).map(x => [x.case_key, x]));
  const linksByRecord = new Map();
  for (const link of links || []) {
    const bucket = linksByRecord.get(link.record_id) || [];
    bucket.push(link);
    linksByRecord.set(link.record_id, bucket);
  }

  const allTags = [...new Set((records || []).flatMap(r => r.tags || []))].sort((a, b) => a.localeCompare(b, "ru"));
  const recordTypes = uniqueValues((records || []).map(r => r.record_type || r.type || ""));
  const confidences = uniqueValues((records || []).map(r => r.confidence || ""));

  const rows = (records || []).map(r => {
    const caseCell = (linksByRecord.get(r.record_id) || []).map(link => {
      const c = caseMap.get(link.case_key);
      return `<div><span class="relation">${esc(link.relation)}</span> ${caseLink(link.case_key, c?.title || link.case_key)}</div>`;
    }).join("");

    const tagHtml = (r.tags || []).map(tag => `
      <button type="button" class="chip tag-filter-button" data-tag="${esc(tag)}" title="Фильтровать по тегу ${esc(tag)}">
        ${esc(tag)}
      </button>
    `).join("");

    return {
      attrs: {
        "data-record-date": r.record_date || "",
        "data-tags": (r.tags || []).map(normalizeFilter).join("||"),
        "data-record-type": r.record_type || r.type || "",
        "data-confidence": r.confidence || ""
      },
      cells: [
        tableCell(recLink(r.record_id), r.record_id),
        tableCell(esc(fmtDate(r.record_date)), fmtDate(r.record_date)),
        tableCell(`<span class="chips">${tagHtml}</span>`, (r.tags || []).join(" ")),
        tableCell(esc(r.record_type || r.type || ""), r.record_type || r.type || ""),
        tableCell(esc(r.confidence || ""), r.confidence || ""),
        tableCell(esc(r.summary || r.title || ""), r.summary || r.title || ""),
        tableCell(caseCell, (linksByRecord.get(r.record_id) || []).map(link => {
          const c = caseMap.get(link.case_key);
          return `${link.relation} ${c?.title || link.case_key}`;
        }).join(" "))
      ]
    };
  });

  if (!isActiveUiGeneration(generation)) return;
  view.innerHTML = `
    <h1>Записи</h1>
    <div class="filter-bar" data-sticky-filter aria-label="Фильтр записей">
      <label>Дата от<input id="records-date-from" type="date"></label>
      <label>Дата до<input id="records-date-to" type="date"></label>
      <label>Тег
        <select id="records-tag-filter">
          <option value="">Все</option>
          ${allTags.map(tag => `<option value="${esc(tag)}">${esc(tag)}</option>`).join("")}
        </select>
      </label>
      ${compactSelect("Тип записи", "records-record-type", recordTypes)}
      ${compactSelect("Подтверждение", "records-confidence", confidences)}
      <div class="active-filter-block">
        <span class="filter-bar-label">Активные теги</span>
        <div id="records-active-tags" class="active-filter-tags"></div>
      </div>
    </div>
    ${filterableTable(["REC","Дата","Домен / теги","Тип записи","Подтверждение","Кратко","Кейс"], rows, { id: "records-index" })}
  `;
  bindFilterableTables();
  setupRecordFilters(initialTags);
}

let inlineTableSequence = 0;

const recordTagLink = (tag) =>
  `<a class="chip record-tag-link" href="#/records?tag=${encodeURIComponent(tag)}">${esc(tag)}</a>`;

function cleanLegacyRecordText(text) {
  let value = String(text || "").trim();

  // Remove legacy migration wrappers such as:
  // ===== REC ... =====, ===== BEGIN FILE: ... =====, ===== END FILE ... =====.
  value = value
    .split(/\r?\n/)
    .filter(line => !/^=+\s*(?:BEGIN\s+FILE:|END\s+FILE:|REC\b|END\s+REC\b).*?=+\s*$/i.test(line.trim()))
    .join("\n")
    .trim();

  // Remove YAML/frontmatter when it is explicitly delimited.
  if (value.startsWith("---")) {
    const second = value.indexOf("\n---", 3);
    if (second >= 0) value = value.slice(second + 4).trim();
  }

  // Some historical volumes contain flattened metadata without --- delimiters.
  // If a medical H1 follows a metadata-looking prefix, keep the H1 and drop only
  // the duplicated technical prefix. recordDisplayTitle() still uses this H1;
  // renderRecordBody() removes the repeated H1 from the visible body.
  const lines = value.split(/\r?\n/);
  const firstH1 = lines.findIndex(line => /^#\s+\S/.test(line.trim()));
  if (firstH1 > 0) {
    const prefix = lines.slice(0, firstH1).join("\n");
    const looksLikeMetadata = /(?:^|\n|\s)(?:type|record_id|date|tags|record_type|confidence|status|source|source_file|source_sha256|source_pages)\s*:/i.test(prefix);
    if (looksLikeMetadata) value = lines.slice(firstH1).join("\n").trim();
  }

  return value;
}

function recordDisplayTitle(record) {
  const cleaned = cleanLegacyRecordText(record.body_text);
  const heading = cleaned.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading && /[А-Яа-яЁё]/.test(heading)) return heading;

  const summary = String(record.summary || "").trim();
  if (summary && /[А-Яа-яЁё]/.test(summary)) {
    const first = summary.split(/[.;]/)[0].trim();
    if (first) return first.charAt(0).toUpperCase() + first.slice(1);
  }

  const fallback = String(record.title || "Запись").replace(/[-_]+/g, " ").trim();
  return fallback.charAt(0).toUpperCase() + fallback.slice(1);
}

function inlineRecordMarkdown(value) {
  let html = esc(value);
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\`([^\`]+)\`/g, "<code>$1</code>");
  html = html.replace(/\[(REC-\d{8}-\d{3})\]/g, (_, id) => recLink(id));
  return html;
}

function parseMarkdownTableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(x => x.trim());
}

// This is a presentation-only transform. The source body_text remains intact.
function readableRecordParagraphs(lines) {
  const text = lines.join(" ").trim();
  if (!text) return "";
  if (text.length < 450) return `<p>${inlineRecordMarkdown(text)}</p>`;
  // Split long prose at clear sentence boundaries; never alter stored medical text.
  const sentences = text.split(/(?<=[.!?…])\s+(?=[А-ЯЁA-Z])/u);
  if (sentences.length < 3) return `<p>${inlineRecordMarkdown(text)}</p>`;
  const paragraphs = [];
  let group = "";
  for (const sentence of sentences) {
    if (group && group.length + sentence.length > 330) {
      paragraphs.push(group);
      group = "";
    }
    group += (group ? " " : "") + sentence;
  }
  if (group) paragraphs.push(group);
  return paragraphs.map(value => `<p>${inlineRecordMarkdown(value)}</p>`).join("\n");
}

function renderRecordBody(text) {
  const cleaned = cleanLegacyRecordText(text);
  const lines = cleaned.split(/\r?\n/);
  if (lines[0]?.startsWith("# ")) lines.shift();

  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    if (!line || /^---+$/.test(line)) {
      i += 1;
      continue;
    }

    if (line.startsWith("|") && i + 1 < lines.length && /^\|?\s*:?-+/.test(lines[i + 1].trim())) {
      const headers = parseMarkdownTableRow(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = parseMarkdownTableRow(lines[i]);
        rows.push(cells.map(cell => tableCell(inlineRecordMarkdown(cell), cell.replace(/\*\*/g, ""))));
        i += 1;
      }
      blocks.push(sortableTable(headers, rows, { id: `record-inline-table-${++inlineTableSequence}` }));
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = Math.min(4, heading[1].length + 1);
      blocks.push(`<h${level}>${inlineRecordMarkdown(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^-\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^-\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^-\s+/, ""));
        i += 1;
      }
      blocks.push(`<ul class="record-list">${items.map(item => `<li>${inlineRecordMarkdown(item)}</li>`).join("")}</ul>`);
      continue;
    }

    const paragraph = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4})\s+/.test(lines[i].trim()) &&
      !/^-\s+/.test(lines[i].trim()) &&
      !lines[i].trim().startsWith("|") &&
      !/^---+$/.test(lines[i].trim())
    ) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    blocks.push(readableRecordParagraphs(paragraph));
  }

  return blocks.join("\n");
}

async function renderRecord(recordId, generation) {
  const [{ data: record, error: recordError }, { data: sourceLinks, error: sourceLinksError }, { data: caseLinks, error: caseLinksError }] = await Promise.all([
    supabase.from("records").select("*").eq("record_id", recordId).single(),
    supabase.from("record_sources").select("source_id,role,source_pages").eq("record_id", recordId),
    supabase.from("case_links").select("case_key,relation,relation_date").eq("record_id", recordId)
  ]);

  if (recordError) throw recordError;
  if (sourceLinksError) throw sourceLinksError;
  if (caseLinksError) throw caseLinksError;

  let relatedCases = [];
  if (caseLinks?.length) {
    const keys = [...new Set(caseLinks.map(x => x.case_key))];
    const result = await supabase.from("cases").select("case_key,title,status").in("case_key", keys);
    if (result.error) throw result.error;
    const map = new Map((result.data || []).map(x => [x.case_key, x]));
    relatedCases = caseLinks.map(link => ({ ...link, case: map.get(link.case_key) }));
  }

  let sourceViews = [];
  if (sourceLinks?.length) {
    const ids = [...new Set(sourceLinks.map(x => x.source_id))];
    const [sourceResult, locationResult] = await Promise.all([
      supabase.from("sources").select("source_id,original_filename").in("source_id", ids),
      supabase.from("source_locations").select("source_id,provider,provider_object_id,location_role").in("source_id", ids)
    ]);
    if (sourceResult.error) throw sourceResult.error;
    if (locationResult.error) throw locationResult.error;

    const sourceMap = new Map((sourceResult.data || []).map(x => [x.source_id, x]));
    sourceViews = sourceLinks.map(link => {
      const locations = (locationResult.data || []).filter(x => x.source_id === link.source_id);
      const preferred = locations.find(x => x.location_role === "PRIMARY" && x.provider === "google-drive")
        || locations.find(x => x.provider === "google-drive");
      return { ...link, source: sourceMap.get(link.source_id), location: preferred };
    });
  }

  const medicationHistory = await medicationHistorySection(recordId);
  if (!isActiveUiGeneration(generation)) return;
  inlineTableSequence = 0;
  const title = recordDisplayTitle(record);
  const body = renderRecordBody(record.body_text);
  const tags = (record.tags || []).map(recordTagLink).join("");

  if (!isActiveUiGeneration(generation)) return;
  view.innerHTML = `
    <p><a href="#/records">← Записи</a></p>
    <h1>${esc(title)}</h1>

    <dl class="record-meta">
      <dt>Дата</dt><dd>${esc(fmtDate(record.record_date))}</dd>
      <dt>ID записи</dt><dd class="mono">${esc(record.record_id)}</dd>
      <dt>Тип записи</dt><dd>${esc(record.record_type || "")}</dd>
      <dt>Подтверждение</dt><dd>${esc(record.confidence || "")}</dd>
    </dl>

    ${tags ? `<div class="record-tags" aria-label="Теги">${tags}</div>` : ""}
    ${record.summary ? `<p class="lead">${esc(record.summary)}</p>` : ""}

    <section>
      <h2>Связанные случаи</h2>
      ${relatedCases.length ? list(relatedCases, x => `
        <li>
          <span class="relation">${esc(x.relation)}</span>
          ${caseLink(x.case_key, x.case?.title || x.case_key)}
          ${x.case?.status ? `<span class="muted"> · ${esc(x.case.status === "closed" ? "закрыт" : "открыт")}</span>` : ""}
        </li>
      `) : empty()}
    </section>

    ${medicationHistory}

    <section>
      <h2>Текст записи</h2>
      <article class="record-body rich-record-body">${body}</article>
    </section>

    <section>
      <h2>Источники</h2>
      ${sourceViews.length ? list(sourceViews, item => {
        const driveId = item.location?.provider_object_id;
        const href = driveId ? `https://drive.google.com/open?id=${encodeURIComponent(driveId)}` : "";
        return `
          <li>
            ${href
              ? `<a href="${href}" target="_blank" rel="noopener noreferrer"><strong>Открыть оригинал</strong></a>`
              : `<strong>${esc(item.source?.original_filename || "Оригинал")}</strong>`}
            ${record.source_label ? `<p>${esc(record.source_label)}</p>` : ""}
            ${item.source_pages ? `<p class="muted">Страницы в источнике: ${esc(item.source_pages)}</p>` : ""}
          </li>
        `;
      }) : empty("Источники не привязаны")}
    </section>
  `;

  bindSortableTables();
}

if ("serviceWorker" in navigator) {
  let hadController = Boolean(navigator.serviceWorker.controller);
  let reloadingForRelease = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !reloadingForRelease) {
      reloadingForRelease = true;
      window.location.reload();
    }
    hadController = true;
  });
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }));
}

boot();
