const STORAGE_KEY = "health.session.v1";
const REVOKED_KEY = "health.session.revoked.v1";

function apiError(status, area) {
  return new Error(`${area} request failed (${status})`);
}

export function createClient(baseUrl, publishableKey) {
  let refreshPromise = null;
  let sessionEpoch = 0;
  // Password requests can overlap without changing the storage epoch.
  // Only the latest *started* attempt may commit credentials.
  let passwordSignInAttempt = 0;
  let locallyRevoked = false;
  // Recovery credentials never enter localStorage or the ordinary reader session.
  let recoverySession = null;
  // Exclusive recovery state: reader/login cannot run while verifying or updating.
  let recoveryMode = false;
  let recoveryAttempt = 0;
  const markRevoked = () => {
    locallyRevoked = true;
    try { sessionStorage.setItem(REVOKED_KEY, "1"); } catch { /* memory fallback */ }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      // localStorage.clear() dispatches a StorageEvent with key === null.
      // Ignore events from sessionStorage; tests may omit storageArea for
      // legacy key-specific notifications, but not for clear().
      if (event.storageArea != null && event.storageArea !== localStorage) return;
      const cleared = event.key === null && event.storageArea === localStorage;
      if (cleared || (event.key === STORAGE_KEY && event.newValue !== event.oldValue)) {
        sessionEpoch += 1;
        if (cleared || event.newValue === null || event.newValue === "") markRevoked();
      }
    });
  }

  // Distinguish a confirmed missing session from an unreadable/invalid one.
  // Logout must never report remote success merely because getItem() failed.
  const inspectStoredSession = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { session: null, knownAbsent: true };
      const session = JSON.parse(raw);
      if (typeof session?.access_token === "string" && session.access_token) {
        return { session, knownAbsent: false };
      }
    } catch {
      // Storage access denied, or corrupt JSON: server session state is unknown.
    }
    return { session: null, knownAbsent: false };
  };

  const load = () => {
    if (locallyRevoked) return null;
    try { if (sessionStorage.getItem(REVOKED_KEY) === "1") return null; } catch { /* memory fallback */ }
    const inspection = inspectStoredSession();
    if (!inspection.knownAbsent && !inspection.session) clear();
    return inspection.session;
  };

  const save = (payload) => {
    if (recoveryMode) throw new Error("Auth recovery in progress");
    if (!payload?.access_token || !payload?.refresh_token || !payload?.user) {
      throw new Error("Incomplete auth session");
    }
    const session = {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      token_type: payload.token_type || "bearer",
      expires_at: payload.expires_at || Math.floor(Date.now() / 1000) + Number(payload.expires_in || 3600),
      user: payload.user
    };
    // Commit the new session first. If persistence fails, do NOT clear the
    // previous revocation marker: it may be protecting an older stored token.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    try {
      sessionStorage.removeItem(REVOKED_KEY);
      if (sessionStorage.getItem(REVOKED_KEY) === "1") {
        throw new Error("Auth state not cleared");
      }
    } catch {
      // Never report a successful login with a still-active tombstone.
      clear();
      throw new Error("Unable to establish local auth session");
    }
    locallyRevoked = false;
    return session;
  };

  const clear = () => {
    sessionEpoch += 1;
    markRevoked();
    try {
      localStorage.removeItem(STORAGE_KEY);
      return true;
    } catch {
      try {
        localStorage.setItem(STORAGE_KEY, "");
        return true;
      } catch {
        return false;
      }
    }
  };

  async function authRequest(path, body, accessToken = "", method = "POST") {
    const headers = {
      apikey: publishableKey,
      "Content-Type": "application/json"
    };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const response = await fetch(`${baseUrl}/auth/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store"
    });
    return response;
  }


  // Exact production redirect: never accept caller-controlled destinations.
  const RECOVERY_REDIRECT = "https://alexio00.github.io/HEALTH/recovery.html";
  const recoveryError = () => new Error("Ссылка восстановления недействительна или устарела.");

  function parseRecoveryFragment(fragment) {
    if (typeof fragment !== "string" || !fragment.startsWith("#") ||
        fragment.length > 8192 || fragment.startsWith("#/")) throw recoveryError();
    const values = new URLSearchParams(fragment.slice(1));
    // Supabase GoTrue can append the empty `sb=` flag after verifying a recovery OTP.
    // Accept only that exact empty value; other unrecognized or duplicate keys fail closed.
    const allowed = new Set(["access_token", "refresh_token", "expires_at", "expires_in", "token_type", "type", "sb"]);
    const seen = new Set();
    for (const [key] of values) {
      if (!allowed.has(key) || seen.has(key)) throw recoveryError();
      seen.add(key);
    }
    if (values.get("sb") !== null && values.get("sb") !== "") throw recoveryError();
    if (values.get("type") !== "recovery" || values.get("token_type")?.toLowerCase() !== "bearer" ||
        !values.get("access_token") || !values.get("refresh_token")) throw recoveryError();
    const expiry = values.get("expires_at");
    const ttl = values.get("expires_in");
    if (expiry !== null && (!/^\d{10,12}$/.test(expiry) || Number(expiry) <= Math.floor(Date.now()/1000))) throw recoveryError();
    if (ttl !== null && (!/^\d{1,6}$/.test(ttl) || Number(ttl) <= 0)) throw recoveryError();
    if (expiry === null && ttl === null) throw recoveryError();
    return { token: values.get("access_token"), expiresAt: expiry !== null ?
      Number(expiry) : Math.floor(Date.now()/1000) + Number(ttl) };
  }

  async function requestPasswordRecovery(email) {
    try {
      if (typeof email !== "string" || email.length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Неверный email.");
      const endpoint = "recover?redirect_to=" + encodeURIComponent(RECOVERY_REDIRECT);
      const response = await authRequest(endpoint, { email });
      return { error: response.ok ? null : apiError(response.status, "Recovery") };
    } catch (error) { return { error }; }
  }

  async function beginPasswordRecovery(fragment) {
    if (recoveryMode) return { error: recoveryError() };
    recoveryMode = true; // synchronous, before token verification
    const attempt = ++recoveryAttempt;
    recoverySession = null;
    // This is intentionally destructive to any previous ordinary reader session.
    // Its storage event also invalidates rendering in other open tabs.
    passwordSignInAttempt += 1;
    if (!clear()) {
      recoveryMode = false;
      return { error: new Error("Не удалось очистить предыдущую сессию.") };
    }
    let artifact;
    try { artifact = parseRecoveryFragment(fragment); }
    catch {
      if (attempt === recoveryAttempt) recoveryMode = false;
      return { error: recoveryError() };
    }
    const expectedEpoch = sessionEpoch;
    try {
      // A client-supplied "type=recovery" is NOT proof. GoTrue validates
      // the bearer against its current server-side user state.
      const response = await authRequest("user", undefined, artifact.token, "GET");
      if (!response.ok) throw recoveryError();
      const user = await response.json();
      if (!user || typeof user.id !== "string" || !user.id ||
          attempt !== recoveryAttempt || !recoveryMode ||
          expectedEpoch !== sessionEpoch || artifact.expiresAt <= Date.now()/1000) {
        throw recoveryError();
      }
      recoverySession = { token: artifact.token, epoch: expectedEpoch, expiresAt: artifact.expiresAt };
      return { error: null };
    } catch {
      if (attempt === recoveryAttempt) recoveryMode = false;
      return { error: recoveryError() };
    }
  }

  async function finishPasswordRecovery(password) {
    const current = recoverySession;
    if (!recoveryMode || !current || current.epoch !== sessionEpoch || Date.now()/1000 >= current.expiresAt)
      return { error: recoveryError(), logoutConfirmed: false };
    if (typeof password !== "string" || password.length < 12 || password.length > 1024)
      return { error: new Error("Пароль должен содержать от 12 до 1024 символов."), logoutConfirmed: false };
    // A local validation error leaves the same link usable. A network attempt
    // consumes it synchronously: no double PUT and no ambiguous retry.
    recoverySession = null;
    let updated = false;
    let error = null;
    let logoutConfirmed = false;
    try {
      const response = await authRequest("user", { password }, current.token, "PUT");
      updated = response.ok;
      if (!updated) error = apiError(response.status, "Password update");
    } catch { error = new Error("Не удалось подтвердить изменение пароля."); }
    // Never offer an in-app authenticated session after a recovery.
    try {
      const response = await authRequest("logout", undefined, current.token);
      logoutConfirmed = response.ok;
    } catch { /* best effort; no token is stored */ }
    const unchanged = recoveryMode && current.epoch === sessionEpoch;
    clear();
    recoveryMode = false;
    recoveryAttempt += 1;
    if (!unchanged) error = new Error("Состояние входа изменилось во время восстановления.");
    return { error: error || null, updated, logoutConfirmed };
  }

  async function cancelPasswordRecovery() {
    const current = recoverySession;
    recoverySession = null;
    recoveryMode = false;
    recoveryAttempt += 1;
    clear();
    if (current) {
      try { await authRequest("logout", undefined, current.token); }
      catch { /* no persisted recovery credentials */ }
    }
  }

  async function refreshSession() {
    if (recoveryMode) return null;
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const current = load();
      const expectedEpoch = sessionEpoch;
      if (!current?.refresh_token) return null;
      const response = await authRequest("token?grant_type=refresh_token", {
        refresh_token: current.refresh_token
      });
      if (!response.ok) {
        if (expectedEpoch === sessionEpoch && load()?.refresh_token === current.refresh_token) clear();
        throw apiError(response.status, "Auth refresh");
      }
      const payload = await response.json();
      if (expectedEpoch !== sessionEpoch || load()?.refresh_token !== current.refresh_token) return null;
      return save(payload);
    })().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  async function ensureSession() {
    if (recoveryMode) return null;
    const current = load();
    if (!current?.access_token) return null;
    const now = Math.floor(Date.now() / 1000);
    if (!current.expires_at || current.expires_at - now <= 60) {
      return refreshSession();
    }
    return current;
  }

  async function restRequest(table, params, retry = true) {
    if (recoveryMode) return { response: null, error: new Error("Auth recovery in progress") };
    const session = await ensureSession();
    if (!session?.access_token) return { response: null, error: new Error("Authentication required") };

    const url = new URL(`${baseUrl}/rest/v1/${encodeURIComponent(table)}`);
    for (const [key, value] of params) url.searchParams.append(key, value);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${session.access_token}`,
        Accept: "application/json"
      },
      cache: "no-store"
    });

    if (response.status === 401 && retry && session.refresh_token) {
      await refreshSession();
      return restRequest(table, params, false);
    }
    if (recoveryMode) return { response: null, error: new Error("Auth recovery in progress") };
    if (!response.ok) return { response, error: apiError(response.status, "Database") };
    return { response, error: null };
  }

  class QueryBuilder {
    constructor(table) {
      this.table = table;
      this.params = [];
      this.mode = "many";
    }

    select(columns = "*") {
      this.params.push(["select", columns]);
      return this;
    }

    eq(column, value) {
      this.params.push([column, `eq.${value}`]);
      return this;
    }

    in(column, values) {
      const safe = (values || []).map(value => String(value).replaceAll('"', '\\"'));
      this.params.push([column, `in.(${safe.join(",")})`]);
      return this;
    }

    contains(column, values) {
      // Conservative text[] membership support for read-only PostgREST queries.
      const list = Array.isArray(values) ? values : [values];
      if (!/^[a-z_]+$/.test(column) || !list.length
          || list.some(value => !/^[A-Za-z0-9_]+$/.test(String(value)))) {
        throw new Error("Unsupported array filter");
      }
      this.params.push([column, "cs.{" + list.join(",") + "}"]);
      return this;
    }

    order(column, { ascending = true, nullsFirst = false } = {}) {
      this.params.push([
        "order",
        `${column}.${ascending ? "asc" : "desc"}.${nullsFirst ? "nullsfirst" : "nullslast"}`
      ]);
      return this;
    }

    limit(value) {
      this.params.push(["limit", String(value)]);
      return this;
    }

    single() {
      this.mode = "single";
      return this;
    }

    maybeSingle() {
      this.mode = "maybeSingle";
      return this;
    }

    async execute() {
      try {
        const { response, error } = await restRequest(this.table, this.params);
        if (error) return { data: null, error };
        const rows = await response.json();
        if (!Array.isArray(rows)) return { data: null, error: new Error("Unexpected database response") };

        if (this.mode === "single") {
          return rows.length === 1
            ? { data: rows[0], error: null }
            : { data: null, error: new Error("Expected exactly one row") };
        }
        if (this.mode === "maybeSingle") {
          return rows.length <= 1
            ? { data: rows[0] || null, error: null }
            : { data: null, error: new Error("Expected zero or one row") };
        }
        return { data: rows, error: null };
      } catch (error) {
        return { data: null, error };
      }
    }

    then(resolve, reject) {
      return this.execute().then(resolve, reject);
    }
  }

  return {
    auth: {
      requestPasswordRecovery,
      beginPasswordRecovery,
      finishPasswordRecovery,
      cancelPasswordRecovery,
      async getSession() {
        if (recoveryMode) return { data: { session: null }, error: new Error("Auth recovery in progress") };
        try {
          const session = await ensureSession();
          return { data: { session }, error: null };
        } catch (error) {
          return { data: { session: null }, error };
        }
      },

      async signInWithPassword({ email, password }) {
        if (recoveryMode)
          return { data: { session: null }, error: new Error("Auth recovery in progress") };
        const attempt = ++passwordSignInAttempt;
        const expectedEpoch = sessionEpoch;
        try {
          const response = await authRequest("token?grant_type=password", { email, password });
          if (!response.ok) return { data: { session: null }, error: apiError(response.status, "Auth") };
          const payload = await response.json();
          // A prior HTTP response must never overwrite a more recent login.
          // This check and save() are synchronous: no async interleaving is
          // possible between the check and the localStorage write.
          if (recoveryMode || attempt !== passwordSignInAttempt || expectedEpoch !== sessionEpoch) {
            throw new Error("Auth state changed");
          }
          const session = save(payload);
          return { data: { session, user: session.user }, error: null };
        } catch (error) {
          return { data: { session: null }, error };
        }
      },

      async signOut() {
        // Inspect storage independently of the revocation tombstone, and retain
        // the difference between "no token" and "cannot read a token".
        const previous = inspectStoredSession();
        const localCleared = clear();
        let remoteConfirmed = previous.knownAbsent;
        try {
          if (previous.session?.access_token) {
            const response = await authRequest("logout", undefined, previous.session.access_token);
            remoteConfirmed = response.ok;
          }
        } catch { remoteConfirmed = false; }
        return {
          error: localCleared && remoteConfirmed
            ? null
            : new Error("Local storage or server logout not confirmed")
        };
      }
    },

    from(table) {
      return new QueryBuilder(table);
    }
  };
}
