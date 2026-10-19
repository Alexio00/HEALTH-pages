// Read-only projection of vaccination history from existing REC summaries and plan items.
// Source text is never modified. Unknown dose/product/links remain unknown.
const dictionaries = [
  {key:"flu", label:"Грипп", re:/грипп|ультрикс|ultrix|гриппол|совигрипп/iu},
  {key:"tbe", label:"Клещевой энцефалит", re:/клещев|энцефалит|клещ-э-вак/iu},
  {key:"meningococcus", label:"Менингококковая инфекция", re:/менингокок|менактра/iu},
  {key:"pneumococcus", label:"Пневмококковая инфекция", re:/пневмокок|превенар|пневмовакс/iu},
  {key:"hpv", label:"ВПЧ", re:/\bHPV\b|впч/iu},
  {key:"hsv", label:"Герпес 1–2 типа", re:/герпес|витагерпавак/iu},
  {key:"covid", label:"COVID-19", re:/covid|ковид|спутник|гам-ковид/iu},
  {key:"hep-a", label:"Гепатит A", re:/гепатит[а-я]*\s*[aа](?=[^\p{L}]|$)|альгавак/iu},
  {key:"hep-b", label:"Гепатит B", re:/гепатит[а-я]*\s*[bв](?=[^\p{L}]|$)|регевак/iu},
  {key:"measles", label:"Корь", re:/кор[ьи]|корев|жкв/iu},
  {key:"rubella", label:"Краснуха", re:/краснух/iu},
  {key:"mumps", label:"Паротит", re:/паротит/iu},
  {key:"polio", label:"Полиомиелит", re:/полиомиелит|полимилекс/iu}
];

const products = [
  [/Ультрикс Квадри|Ultrix Quadri/iu, "Ультрикс Квадри"],
  [/Ультрикс/iu, "Ультрикс"],
  [/Гриппол плюс|Гриппол\+/iu, "Гриппол плюс"],
  [/Гриппол/iu, "Гриппол"],
  [/Совигрипп/iu, "Совигрипп"],
  [/Клещ-Э-Вак/iu, "Клещ-Э-Вак"],
  [/Менактра/iu, "Менактра"],
  [/Пневмовакс\s*23/iu, "Пневмовакс 23"],
  [/Превенар\s*13/iu, "Превенар 13"],
  [/Альгавак/iu, "Альгавак"],
  [/Регевак/iu, "Регевак"],
  [/АДС[-‑ ]?М/iu, "АДС-М"],
  [/ММР[-‑ ]?(?:II|2)|MMR[-‑ ]?(?:II|2)/iu, "ММР-II"],
  [/ЖКВ/iu, "ЖКВ"],
  [/Гам-КОВИД-Вак/iu, "Гам-КОВИД-Вак"],
  [/Спутник Лайт/iu, "Спутник Лайт"],
  [/Витагерпавак/iu, "Витагерпавак"],
  [/Пентаксим/iu, "Пентаксим"],
  [/Полимилекс/iu, "Полимилекс"]
];

const knownKey = Object.fromEntries(dictionaries.map(item => [item.key, item]));
const has = (text, re) => re.test(String(text || ""));
const uniq = list => [...new Set(list)];
const dateKey = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "";
const recId = value => /^REC-\d{8}-\d{3}$/.test(String(value || "")) ? String(value) : null;

function targets(fragment) {
  if (has(fragment, /АКДС/iu)) {
    return { keys:["diphtheria","tetanus","pertussis"], label:"Дифтерия, столбняк, коклюш" };
  }
  if (has(fragment, /Пентаксим/iu)) {
    return {
      keys:["diphtheria","tetanus","pertussis","polio","hib"],
      label:"Дифтерия, столбняк, коклюш, полиомиелит, гемофильная инфекция"
    };
  }
  if (has(fragment, /АДС[-‑ ]?М/iu)) {
    return { keys:["diphtheria","tetanus"], label:"Дифтерия, столбняк" };
  }
  if (has(fragment, /ММР[-‑ ]?(?:II|2)|MMR|кор[ьи].*краснух.*паротит/iu)) {
    return { keys:["measles","rubella","mumps"], label:"Корь, краснуха, паротит" };
  }
  const keys = dictionaries.filter(item => item.re.test(fragment)).map(item => item.key);
  if (!keys.length) return null;
  return { keys:uniq(keys), label:keys.map(key => knownKey[key].label).join(", ") };
}

function vaccineName(fragment) {
  const found = products.find(([pattern]) => pattern.test(fragment));
  return found ? found[1] : "";
}

// This projection is intentionally conservative: planned administrations must
// not become "actual" infections or stages solely because they share a REC.
const FUTURE_CLAUSE = /(?:в\s+будущем|в\s+дальнейшем|следующ\p{L}*|предстоит|планир\p{L}*|запланир\p{L}*|рекоменд\p{L}*|назначен\p{L}*|будет\s+(?:сделан\p{L}*|выполнен\p{L}*|проведен\p{L}*|проведён\p{L}*))/iu;
const EXPLICIT_STAGE = /\b(?:RV[1-9]\d*|R[1-9]\d*|V[1-9]\d*)\b|доз[аыуе]\s*№?\s*[1-9]\d*|[1-9]\d*[-‑]?(?:я|ая)\s+доз[аыуе]|(?:перв\p{L}*|втор\p{L}*)\s+вакцинац/iu;

// Split only at event boundaries OUTSIDE parentheses. A comma inside
// "(Rv2, запланирована)" is part of the same, future-only vaccination.
function logicalAdministrationClauses(source) {
  const clauses = [];
  let depth = 0, start = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth < 0) return null;
    }
    if (depth !== 0) continue;
    const conjunction = source.slice(i, i + 3).toLocaleLowerCase("ru") === " и ";
    if (char === "," || char === ";" || conjunction) {
      clauses.push(source.slice(start, i).trim());
      if (conjunction) i += 2;
      start = i + 1;
    }
  }
  if (depth !== 0) return null; // Malformed event evidence: fail closed.
  clauses.push(source.slice(start).trim());
  return clauses.filter(Boolean);
}

// A plan can follow an explicitly recorded stage INSIDE one parenthesis,
// e.g. "(ЖКВ, V1, краснуха запланирована)". Retain the prior event only
// when its own stage is explicit AND the suffix names a separate antigen
// or future revaccination. "(Rv2, запланирована)" is never sufficient.
function performedPrefixBeforeInlinePlan(clause) {
  const future = FUTURE_CLAUSE.exec(clause);
  if (!future) return null;
  const before = clause.slice(0, future.index);
  const split = Math.max(before.lastIndexOf(","), before.lastIndexOf(";"));
  if (split < 0) return null;
  const prefix = clause.slice(0, split).trim();
  const futureTail = clause.slice(split + 1).trim();
  const earlier = targets(prefix);
  const later = targets(futureTail);
  if (!EXPLICIT_STAGE.test(prefix) || !earlier) return null;
  const separateAntigen = Boolean(later &&
    later.keys.some(key => !earlier.keys.includes(key)));
  const futureBooster = /\bRV[1-9]\d*\b|\bR[1-9]\d*\b|ревакцинац/iu.test(futureTail);
  if (!separateAntigen && !futureBooster) return null;
  const open = (prefix.match(/\(/g) || []).length - (prefix.match(/\)/g) || []).length;
  if (open < 0) return null;
  return prefix + ")".repeat(open);
}

function performedAdministration(fragment) {
  const clauses = logicalAdministrationClauses(String(fragment || ""));
  if (!clauses) return "";
  const performed = [];
  for (const clause of clauses) {
    if (FUTURE_CLAUSE.test(clause)) {
      // Standalone ", запланирована" is a postfix status for the
      // immediately preceding event, not a new medical event.
      if (/^(?:запланир\p{L}*|планир\p{L}*|назначен\p{L}*|рекоменд\p{L}*|предстоит)[.!]?$/iu.test(clause))
        performed.pop();
      const prefix = performedPrefixBeforeInlinePlan(clause);
      if (prefix) performed.push(prefix);
      break;
    }
    performed.push(clause);
  }
  return performed.join(", ").trim();
}
function stageForActual(fragment, keys) {
  const performed = performedAdministration(fragment);
  if (!performed) return "—";
  const claims = [];
  // Read all explicit dose references, not just the first Latin stage token.
  for (const match of performed.matchAll(/\b(?:RV[1-9]\d*|RV|R[1-9]\d*|V[1-9]\d*)\b/giu)) {
    const code = match[0].toUpperCase();
    claims.push(code.startsWith("RV") ? "Rv" + code.slice(2)
      : code.startsWith("R") ? "Rv" : code);
  }
  for (const match of performed.matchAll(/доз[аыуе]\s*№?\s*([1-9]\d*)|([1-9]\d*)[-‑]?(?:я|ая)\s+доз[аыуе]/giu)) {
    claims.push("V" + (match[1] || match[2]));
  }
  if (has(performed, /первая вакцинация основного курса|\b1[-‑]й этап|компонент\s*I\b/iu)) claims.push("V1");
  if (has(performed, /вторая вакцинация|компонент\s*II\b/iu)) claims.push("V2");
  if (has(performed, /ревакцинац/iu) && !claims.some(stage => stage.startsWith("Rv"))) claims.push("Rv");
  const unique = uniq(claims);
  if (unique.length > 1) return "—";
  // Preserve the previously accepted seasonal-flu display convention.
  if (keys.includes("flu")) return "Rv";
  if (!unique.length) return "—";
  // A shared multi-infection REC does not prove a shared numbered booster.
  if (keys.length > 1 && /^Rv\d+$/.test(unique[0])) return "—";
  return unique[0];
}
function administeredSummary(summary) {
  const s = String(summary || "");
  return has(s, /(^|\s)Вакцинация\s*:|выполнена вакцинация|привит[аы]?\s+от|вакцинация против|вторая вакцинация|вторая доза/iu);
}

function splitAdministrationSummary(summary) {
  const s = String(summary || "")
    .replace(/\)\s+и\s+В\s*\(/giu, ") + гепатит В (")
    .replace(/\s+и\s+(?=АДС[-‑ ]?М)/giu, " + ")
    .replace(/([а-я])\/([а-я])/giu, "$1 + $2");
  return s.split(/\s+\+\s+/u);
}

// Extract only explicitly performed injections inside a vaccination section.
// Never interpret a separate "Рекомендации", "Будущий план" or anamnesis block
// as proof of administration. A consultation-only heading is insufficient.
function bodyAdministrationFragments(body) {
  const lines = String(body || "").split(/\r?\n/);
  const fragments = [];
  let inVaccination = false;
  let pending = "";
  const flush = () => {
    if (pending.trim()) fragments.push(pending.trim());
    pending = "";
  };
  for (const line of lines) {
    const clean = line.trim().replace(/\*\*/g, "");
    const markdownHeading = /^#{1,6}\s+(.+)$/u.exec(clean);
    const boldHeading = /^\*\*([^*]+)\*\*\s*$/u.exec(line.trim());
    if (markdownHeading || boldHeading) {
      flush();
      const heading = String(markdownHeading?.[1] || boldHeading?.[1] || "")
        .replace(/\*\*/g, "").replace(/:\s*$/, "").trim().toLowerCase();
      inVaccination = /^(вакцинация|выполненные вакцинации|заключение и выполненные вакцинации)/u.test(heading);
      continue;
    }
    if (!inVaccination) continue;
    const isBullet = /^\s*[-*]\s+/.test(line);
    const candidate = clean.replace(/^[-*]\s*/, "");
    const explicit = /^(?:вакцинирован[аы]?\s+от|вакцинация\s+против|против\s+|вакцина\s*:)/iu.test(candidate);
    if (isBullet && explicit) {
      flush();
      pending = candidate;
    } else if (pending && !isBullet && clean
        && !/^(?:Противопоказаний|Добровольное|Общие|Местные)/iu.test(clean)) {
      // Wrapped text can contain an explicit dose number. Never scan
      // later sections; headings above terminate the active extraction.
      pending += " " + clean;
    } else if (isBullet) {
      flush();
    }
  }
  flush();
  return fragments;
}

export function actualVaccinations(records) {
  const events = [];
  for (const record of records || []) {
    if (String(record.status || "").toLowerCase() === "cancelled") continue;
    const tagged = (record.tags || []).some(x => String(x).toUpperCase() === "VACCINATION")
      || has(record.title, /vakcinaciya|вакцинац|прививк/iu);
    if (!tagged || !dateKey(record.record_date)) continue;
    const summary = String(record.summary || "");
    const fromBodyEvidence = bodyAdministrationFragments(record.body_text);
    if (!administeredSummary(summary) && !fromBodyEvidence.length) continue;
    const fromBody = fromBodyEvidence;
    const fragments = fromBody.length ? fromBody : splitAdministrationSummary(summary);
    for (const fragment of fragments) {
      const performed = performedAdministration(fragment);
      if (!performed) continue;
      const target = targets(performed);
      if (!target) continue;
      const keys = target.keys;
      const label = target.label;
      events.push({
        kind:"actual", id:String(record.record_id) + ":" + keys.join("-"),
        keys, infection:label, stage:stageForActual(performed, keys),
        date:record.record_date, vaccine:vaccineName(performed),
        appointmentRecordId:recId(record.metadata?.appointment_record_id),
        administrationRecordId:recId(record.record_id),
        basisRecordId:null, status:"done", sourceStatus:"Проведена"
      });
    }
  }
  return events.sort((a,b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

function stageForPlan(item) {
  const meta = item.metadata || {};
  if (/^V[1-9]\d*$/iu.test(String(meta.stage || ""))) return String(meta.stage).toUpperCase();
  const metadataBooster = String(meta.stage || "").match(/^RV([1-9]\d*)?$/iu);
  if (metadataBooster) return "Rv" + (metadataBooster[1] || "");
  const titleBooster = String(item.title || "").match(/\bRv([1-9]\d*)\b/iu);
  if (titleBooster) return "Rv" + titleBooster[1];
  if (has(item.title, /повторный курс.*5\s+доз/iu)) return "V1–V5";
  if (has(item.title, /ревакцинац|ежегодн/iu)) return "Rv";
  return "—";
}

// Read-only UI: source text asserting a clinical "overdue" verdict is not
// verified proof. A single shared sanitizer prevents drift between the plan
// table, its filters, and all vaccination views.
export function neutralPlanSourceStatus(value, fallback = "Запланировано") {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return "Статус требует уточнения";
  const status = value.trim();
  if (!status) return fallback;
  // The canonical plan row is still "planned"; source assertions of
  // medical overdue have not been independently verified.
  return /(?:^|[^\p{L}])(?:просрочено|overdue)(?=$|[^\p{L}])/iu.test(status)
    ? fallback : status;
}

export function plannedVaccinations(items, today = moscowToday()) {
  return (items || []).filter(x => normalizeKind(x.metadata?.kind) === "вакцинация")
    .map(x => {
      const t = targets(String(x.title || ""));
      const due = dateKey(x.due_on);
      const status = String(x.status || "planned");
      // A calendar date alone does not prove an outstanding medical obligation.
      const sourceStatus = neutralPlanSourceStatus(x.metadata?.source_status);
      return {
        kind:"plan", id:"plan:" + x.plan_item_id, keys:t?.keys || [],
        infection:t?.label || String(x.title || ""), stage:stageForPlan(x),
        date:due, dateText:due ? "" : String(x.metadata?.due_text || "Срок не указан"),
        vaccine:String(x.metadata?.vaccine_name || x.metadata?.vaccine || ""),
        appointmentRecordId:recId(x.metadata?.appointment_record_id),
        administrationRecordId:recId(x.metadata?.administration_record_id),
        basisRecordId:recId(x.basis_record_id), status,
        sourceStatus:status === "cancelled" ? "Отменено"
          : status === "done" ? "Выполнено"
          : sourceStatus,
        overdue:false, title:String(x.title || "")
      };
    }).sort((a,b) => {
      if (!a.date && !b.date) return a.id.localeCompare(b.id);
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
    });
}
function normalizeKind(value) {
  return String(value || "").trim().toLocaleLowerCase("ru");
}
export function moscowToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone:"Europe/Moscow", year:"numeric", month:"2-digit", day:"2-digit"
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return byType.year + "-" + byType.month + "-" + byType.day;
}

function intersection(a,b) {
  return a.some(key => b.includes(key));
}
export function buildVaccinationView(records, planItems, today = moscowToday()) {
  const actual = actualVaccinations(records);
  const plans = plannedVaccinations(planItems,today);
  const upcoming = plans.filter(item => item.status === "planned");
  const latestPerAntigen = new Map();
  for (const item of actual) {
    for (const key of item.keys) {
      if (!latestPerAntigen.has(key)) latestPerAntigen.set(key,item);
    }
  }
  const latest = uniq([...latestPerAntigen.values()]).sort(
    (a,b) => a.infection.localeCompare(b.infection,"ru")
  ).map(item => {
    const next = upcoming.find(plan => intersection(plan.keys,item.keys));
    return {...item, next:next || null};
  });
  const history = [...actual, ...plans].sort((a,b) =>
    (b.date || "").localeCompare(a.date || "") || a.id.localeCompare(b.id)
  );
  return {latest, planned:upcoming, history};
}
