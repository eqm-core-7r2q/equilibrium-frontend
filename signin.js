// Equilibrium sign-in page. This is everything the public site contains: a form, and a loader that fetches the
// screens from private storage with the signed-in user's token: the rate engine, or under <root>app the
// app. No pricing, no screens, no secrets.
(() => {
  "use strict";
  if (window.top !== window.self) { document.documentElement.hidden = true; return; }   // never run inside a frame
  const CFG = window.EQ_CONFIG || {};
  const URL_ = String(CFG.supabaseUrl || "").replace(/\/+$/, ""), KEY = CFG.publishableKey || "";
  const $ = (id) => document.getElementById(id);
  const msg = (text, isError) => { const m = $("msg"); m.textContent = text || ""; m.hidden = !text; m.className = "msg" + (isError ? " err" : ""); };
  const ROOT = /^\/([A-Za-z0-9._-]+\/)?$/.test(CFG.root || "") ? CFG.root : null;   // "/" on a domain of its own, "/repo-name/" under a shared one
  const APP_MODE = !!ROOT && (location.pathname === ROOT + "app" || location.pathname.startsWith(ROOT + "app/"));
  const STAFF_MODE = APP_MODE && (location.pathname === ROOT + "app/admin" || location.pathname.startsWith(ROOT + "app/admin/"));   // storage serves that file to staff only
  // <root>master opens the Master Admin console (item 69), for Equilibrium admins only
  const MASTER_MODE = !!ROOT && (location.pathname === ROOT + "master" || location.pathname.startsWith(ROOT + "master/"));
  const WHAT = MASTER_MODE ? "the admin console" : APP_MODE ? "the app" : "the rate engine";
  const REFRESH_KEY = "eq.refresh";   // tab-scoped; lets a reload stay signed in. This page keeps the access token in memory only
                                      // (the app, once it has the session, keeps it whole in the same tab-scoped storage).
  let session = null, refreshTimer = null, refreshing = null;

  const call = async (path, { method = "POST", body, token } = {}) => {
    const res = await fetch(URL_ + path, { method, headers: { apikey: KEY, "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, data };
  };

  // `remember: false` keeps the session in memory only (used for a session that arrived in an email link, until its password is chosen)
  const setSession = (s, remember = !MASTER_MODE) => {   // the admin console never writes its session to storage
    session = s && s.access_token ? { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: Date.now() + (Number(s.expires_in) || 3600) * 1000, email: s.user && s.user.email } : null;
    clearTimeout(refreshTimer);
    try { if (session && session.refresh_token && remember) sessionStorage.setItem(REFRESH_KEY, session.refresh_token); else sessionStorage.removeItem(REFRESH_KEY); } catch { /* storage unavailable: stay signed in for this page load only */ }
    if (session) refreshTimer = setTimeout(() => { refresh().catch(() => {}); }, Math.max(30000, session.expires_at - Date.now() - 60000));
  };
  const refresh = () => refreshing || (refreshing = (async () => {
    let rt = session && session.refresh_token; if (!rt) { try { rt = sessionStorage.getItem(REFRESH_KEY); } catch { rt = null; } }
    if (!rt) return false;
    const r = await call("/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: rt } });
    if (!r.ok) { setSession(null); return false; }
    setSession(r.data); return true;
  })().finally(() => { refreshing = null; }));
  const getToken = async () => {
    if (!session || session.expires_at - Date.now() < 30000) { if (!(await refresh())) { signOut(); throw new Error("signed out"); } }
    return session.access_token;
  };
  const signOut = () => {
    const t = session && session.access_token; setSession(null);
    // keepalive: the request outlives the navigation, so the refresh token is revoked server-side
    if (t) { try { fetch(URL_ + "/auth/v1/logout", { method: "POST", keepalive: true, headers: { apikey: KEY, Authorization: "Bearer " + t } }).catch(() => {}); } catch { /* best effort */ } }
    location.replace(location.pathname);
  };

  // ---- load the screens from private storage and hand over
  const TIERS = /^(broker|carrier|retail|wholesale)$/;
  const storageGet = async (name) => {
    if (!/^[a-z0-9_.\-]+(\/[a-z0-9_.\-]+)*$/i.test(name) || name.includes("..")) throw new Error("bad path");
    const res = await fetch(`${URL_}/storage/v1/object/authenticated/app/${name.split("/").map(encodeURIComponent).join("/")}`, { headers: { apikey: KEY, Authorization: "Bearer " + (await getToken()) } });
    if (!res.ok) throw Object.assign(new Error("load " + name), { status: res.status });
    return res.text();
  };
  const runScript = (code) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    const s = document.createElement("script"); s.src = url;
    s.onload = () => { URL.revokeObjectURL(url); resolve(); }; s.onerror = () => { URL.revokeObjectURL(url); reject(new Error("script")); };
    document.head.append(s);
  });
  // The app: one file per tenant type; storage serves a member only their own type's. The app then keeps the
  // session fresh itself and keeps this page's copy of the refresh token current, so this page stops refreshing.
  const mountApp = async (tier) => {
    const code = await storageGet(tier + "/mobile/entry.js");
    await getToken();
    const st = document.createElement("style"); st.textContent = "html,body{height:100%}body{overflow:hidden}#root{display:flex;height:100%;flex:1}";
    const root = document.createElement("div"); root.id = "root"; root.hidden = true;
    window.EQ_APP_BOOT = { session: { access_token: session.access_token, refresh_token: session.refresh_token }, home: ROOT + (tier === "admin" ? "app/admin/" : "app/") };
    document.head.append(st); document.body.append(root);
    try { await runScript(code); }
    catch (e) { delete window.EQ_APP_BOOT; st.remove(); root.remove(); throw e; }   // nothing was handed over: the form and its message stay
    clearTimeout(refreshTimer); session = null;
    $("gate").hidden = true; root.hidden = false; msg("");
  };
  // The admin console: the master door says whether this account holds an admin level; storage then serves the
  // console's files to active admins only. This page keeps the session and hands the console a way to ask for the token.
  const mountMaster = async () => {
    const who = await fetch(URL_ + "/functions/v1/master", { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json", Authorization: "Bearer " + (await getToken()) }, body: JSON.stringify({ action: "whoami" }) });
    if (!who.ok) throw Object.assign(new Error("master"), { status: who.status });
    const [css, code] = await Promise.all([storageGet("staff/master/styles.css"), storageGet("staff/master/entry.js")]);
    const st = document.createElement("style"); st.textContent = css;
    const root = $("app");
    window.EQ_MASTER_BOOT = { functionsUrl: URL_ + "/functions/v1", apikey: KEY, getToken, signOut, root };
    document.head.append(st);
    try { await runScript(code); }
    catch (e) { delete window.EQ_MASTER_BOOT; st.remove(); throw e; }
    $("gate").hidden = true; root.hidden = false; msg("");
  };
  const mount = async () => {
    msg("Loading…");
    try {
      if (STAFF_MODE) return await mountApp("admin");
      if (MASTER_MODE) return await mountMaster();
      // which tier this user belongs to comes from the pricing API; storage then serves only the common files and that tier's view
      const sres = await fetch(URL_ + "/functions/v1/pricing/session", { headers: { apikey: KEY, Authorization: "Bearer " + (await getToken()) } });
      if (!sres.ok) throw Object.assign(new Error("session"), { status: sres.status });
      const tier = String((await sres.json()).tenant_type || "");
      if (!TIERS.test(tier)) throw Object.assign(new Error("tier"), { status: 403 });
      if (APP_MODE) return await mountApp(tier);
      const manifest = JSON.parse(await storageGet(tier + "/manifest.json"));
      const [shell, styles, scripts] = await Promise.all([storageGet(manifest.shell), Promise.all(manifest.styles.map(storageGet)), Promise.all(manifest.scripts.map(storageGet))]);
      for (const css of styles) { const st = document.createElement("style"); st.textContent = css; document.head.append(st); }
      const root = $("app");
      root.replaceChildren(document.createRange().createContextualFragment(shell));   // our own file, read from our own private bucket
      window.EQ_BOOT = { functionsUrl: URL_ + "/functions/v1/pricing", apikey: KEY, getToken, signOut };
      for (const code of scripts) await runScript(code);
      $("gate").hidden = true; root.hidden = false; msg("");
      window.EQ.start(root);
    } catch (e) {
      if (e && e.status === 401) { setSession(null); $("signin").hidden = false; msg("Your session has ended. Sign in again.", true); }
      else if (e && (e.status === 400 || e.status === 403 || e.status === 404)) msg("This account is signed in but has no access to " + WHAT + ". Contact Equilibrium.", true);
      else msg(WHAT.charAt(0).toUpperCase() + WHAT.slice(1) + " could not be loaded. Try again in a minute.", true);
    }
  };

  // ---- forms
  $("signin").addEventListener("submit", async (e) => {
    e.preventDefault(); msg("");
    const email = $("email").value.trim(), password = $("password").value;
    if (!email || !password) return msg("Enter your email and password.", true);
    $("signin-btn").disabled = true;
    try {
      const r = await call("/auth/v1/token?grant_type=password", { body: { email, password } });
      if (!r.ok) return msg(r.status === 429 ? "Too many attempts. Wait a minute and try again." : "That email and password did not match.", true);
      setSession(r.data, !MASTER_MODE); $("password").value = ""; await mount();   // the admin console keeps its session in memory only: a reload signs in again
    } catch { msg("Could not reach the server. Check your connection.", true); }
    finally { $("signin-btn").disabled = false; }
  });
  $("forgot").addEventListener("click", async () => {
    const email = $("email").value.trim(); if (!email) return msg("Enter your email first, then choose Forgot password.", true);
    try { await call("/auth/v1/recover", { body: { email } }); } catch { /* same message either way */ }
    msg("If that address has an account, a link to choose a new password is on its way.");
  });
  $("setpw").addEventListener("submit", async (e) => {
    e.preventDefault(); msg("");
    const a = $("pw1").value, b = $("pw2").value;
    if (a.length < 12) return msg("Use at least 12 characters.", true);
    let bytes = a.length * 3; try { bytes = encodeURIComponent(a).replace(/%[0-9A-F]{2}/g, "x").length; } catch { /* counted as too long */ }
    if (bytes > 72) return msg("Use 72 characters or fewer. Longer passwords are not accepted.", true);
    if (a !== b) return msg("The two passwords are not the same.", true);
    $("setpw-btn").disabled = true;
    try {
      const r = await call("/auth/v1/user", { method: "PUT", body: { password: a }, token: await getToken() });
      if (!r.ok) return msg(r.status === 422 || r.status === 400 ? "That password was not accepted. Choose a different one, 12 to 72 characters." : "The password could not be saved. Open the link from your email again.", true);
      $("pw1").value = ""; $("pw2").value = ""; $("setpw").hidden = true;
      try { if (session && session.refresh_token && !MASTER_MODE) sessionStorage.setItem(REFRESH_KEY, session.refresh_token); } catch { /* stays in memory */ }   // only now is the link's session remembered
      await mount();
    } catch { msg("Could not reach the server. Check your connection.", true); }
    finally { $("setpw-btn").disabled = false; }
  });

  // ---- start: an invite or reset link arrives with the session in the URL fragment; otherwise try to resume
  (async () => {
    if (!URL_ || !KEY || /__SUPABASE/.test(URL_)) return msg("This page is not configured yet.", true);
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (hash.get("access_token")) {
      history.replaceState(null, "", location.pathname);   // take the tokens out of the address bar at once
      // A session in the address bar is accepted only from an invite or password-reset email, and only to choose a password.
      // Any other link carrying tokens is ignored: nobody can be signed in to someone else's account by following a link.
      if (!["recovery", "invite"].includes(hash.get("type") || "")) return msg("That link cannot be used to sign in. Enter your email and password.", true);
      const fromLink = { access_token: hash.get("access_token"), refresh_token: hash.get("refresh_token"), expires_in: hash.get("expires_in") };
      const u = await call("/auth/v1/user", { method: "GET", token: fromLink.access_token });
      if (!u.ok) return msg("That link has expired. Ask Equilibrium for a new one.", true);
      setSession(fromLink, false);   // not remembered: a reload before the password is chosen returns to the sign-in form
      $("signin").hidden = true; $("setpw").hidden = false; $("setpw-who").textContent = "You are choosing the password for " + (u.data.email || "this account") + ".";
      return;
    }
    if (hash.get("error_description")) msg("That link has expired or was already used. Ask Equilibrium for a new one.", true);
    if (!MASTER_MODE && await refresh().catch(() => false)) { $("signin").hidden = true; await mount(); if ($("app").hidden && !window.EQ_APP_BOOT) $("signin").hidden = false; }
  })();
})();
