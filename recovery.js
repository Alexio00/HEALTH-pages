// Standalone recovery entrypoint. No reader or clinical module is ever imported.
// Query suffix bypasses the shell-only, cache-first behavior of legacy SW builds.
import { createClient } from "./supabase-client.js?recovery-entry-v1";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js?recovery-entry-v1";

const auth = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY).auth;
const $ = id => document.getElementById(id);
const panels = ["recovery-loading", "recovery-invalid", "recovery-ready", "recovery-done"];
const show = id => panels.forEach(name => $(name).classList.toggle("hidden", name !== id));
let consumed = false;
let busy = false;
let valid = false;

function invalid(message = "Ссылка восстановления недействительна или истекла. Запросите новое письмо.") {
  $("recovery-error").textContent = message;
  show("recovery-invalid");
}

async function initialize() {
  // No awaited network operation before the browser's URL has been scrubbed.
  const fragment = location.hash;
  let clean = false;
  try {
    history.replaceState(null, "", location.pathname);
    clean = !location.search && !location.hash;
  } catch {
    // Keep the medical reader out of the document; drop tokens by navigation.
    try { location.replace("./recovery.html"); } catch { /* fail closed */ }
  }
  if (!clean) return;
  if (!fragment || fragment.startsWith("#/")) {
    invalid();
    return;
  }
  try {
    const result = await auth.beginPasswordRecovery(fragment);
    if (consumed) return;
    if (result.error) return invalid();
    valid = true;
    show("recovery-ready");
    $("recovery-password").focus();
  } catch {
    invalid();
  }
}

$("recovery-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!valid || busy || consumed) return;
  const first = $("recovery-password");
  const second = $("recovery-confirm");
  const status = $("recovery-status");
  if (!first.value || !second.value || first.value !== second.value) {
    status.textContent = "Пароли не совпадают.";
    return;
  }
  if (!$("recovery-form").reportValidity()) return;
  busy = true;
  $("recovery-save").disabled = true;
  status.textContent = "Изменяю пароль…";
  let outcome;
  try {
    outcome = await auth.finishPasswordRecovery(first.value);
  } catch {
    outcome = { error: new Error("Recovery failed") };
  } finally {
    first.value = "";
    second.value = "";
    busy = false;
    $("recovery-save").disabled = false;
  }
  if (consumed) return;
  if (outcome?.error || !outcome?.updated) {
    valid = false;
    consumed = true;
    await auth.cancelPasswordRecovery();
    invalid("Не удалось подтвердить изменение пароля. Запросите новую ссылку.");
    return;
  }
  consumed = true;
  valid = false;
  $("recovery-result").textContent = outcome.logoutConfirmed
    ? "Войдите с новым паролем."
    : "Пароль изменён. Серверный выход не подтверждён. Повторите обычный вход.";
  show("recovery-done");
});

$("recovery-cancel").addEventListener("click", () => {
  if (consumed) return;
  consumed = true;
  valid = false;
  $("recovery-password").value = "";
  $("recovery-confirm").value = "";
  show("recovery-invalid");
  void auth.cancelPasswordRecovery();
});

// Never register a service worker here. Existing controllers intercept only
// their allowlisted shell assets; this page and script remain network-only.
void initialize();
