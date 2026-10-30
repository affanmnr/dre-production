/* ============ STORAGE: Supabase ============
   The team's data lives in Supabase (see supabase/schema.sql): one row per project / plot / panel /
   attendance day plus one config row, each holding the same JSON the screens work with. Everyone who is
   signed in sees changes live; what each person may change is enforced by the database's access rules. */
const SUPABASE_URL = 'https://iooejsiuqotpqdgmrkta.supabase.co';
const SUPABASE_KEY = 'sb_publishable_4GGSCjgT0la9g_AcFvdbfw_EkM9u1C3'; // publishable key: meant to be public
const CFG_KEYS = ['employees','steps','machines','sizes','quickTasks'];
const COLS = ['projects','plots','panels','attendance'];
const PLOT_WINDOW_DAYS = 120;
const lsGet = k => { try { return localStorage.getItem(k); } catch(e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch(e) {} };
const clone = v => JSON.parse(JSON.stringify(v));
function emptyState(){ return Object.assign(seed(), {projects:[], plots:[], panels:[], doneManual:{}, attendance:{}}); }

const sb = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;
let S = emptyState();
let READY = false, CAN_WRITE = true, PENDING_RENDER = false, SESSION = null, ME = null, PEOPLE = [], DATA_STARTED = false;

// Roles come from the person's row in `profiles`; the database enforces the same split.
const ROLE_PAGES = {master:['dashboard','projects','plot','panel','today','settings'], full:['dashboard','projects','plot','panel','today','settings'], ops:['plot','panel','today'], viewer:['today'], pending:['today']};
const ROLE_LABEL = {master:'Master admin', full:'Akses penuh', ops:'Admin plotting & panel', viewer:'Karyawan (lihat Hari Ini)', pending:'Menunggu persetujuan'};
const ROLE_OPTS = [['pending', 'Menunggu (belum ada akses)'], ['viewer', 'Karyawan: lihat Hari Ini'], ['ops', 'Admin: Plotting, Panel & Hari Ini'], ['full', 'Akses penuh'], ['master', 'Master admin']];
const WRITERS = ['master', 'full', 'ops'];
let ROLE = null;
const canSee = page => !!ROLE && ROLE_PAGES[ROLE].includes(page);

const BASE = {config:null, projects:{}, plots:{}, panels:{}, attendance:{}};
const QUEUE = {};

// key-order-independent JSON, so a row read back compares equal to what we wrote
const stable = v => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
  : JSON.stringify(v === undefined ? null : v);
const cfgOf = () => { const c = {}; CFG_KEYS.forEach(k => c[k] = S[k]); return c; };
function projDoc(p){
  const done = {}, pre = p.id + '|';
  Object.keys(S.doneManual).forEach(k => { if (k.startsWith(pre) && S.doneManual[k]) done[k.slice(pre.length)] = true; });
  return Object.assign({}, p, {done});
}
function docsOf(col){
  if (col === 'projects') return S.projects.map(p => [p.id, projDoc(p)]);
  if (col === 'attendance') return Object.entries(S.attendance);
  return S[col].map(x => [x.id, x]);
}

// Write every row that differs from what the database last had; delete rows that disappeared.
function save(){
  if (!READY || !sb) return;
  if (!WRITERS.includes(ROLE)) { toast('Akses kamu hanya melihat, perubahan tidak tersimpan'); return; }
  if (ROLE !== 'ops') {
    const c = cfgOf(), cj = stable(c);
    if (cj !== BASE.config) { BASE.config = cj; write('config/main', () => sb.from('app_config').upsert({id: 'main', data: clone(c)})); }
  }
  COLS.forEach(col => {
    const base = BASE[col], seen = new Set();
    docsOf(col).forEach(([id, doc]) => {
      seen.add(id); const j = stable(doc);
      if (base[id] !== j) { base[id] = j; write(col + '/' + id, () => sb.from(col).upsert({id, data: clone(doc)})); }
    });
    Object.keys(base).forEach(id => { if (!seen.has(id)) { delete base[id]; write(col + '/' + id, () => sb.from(col).delete().eq('id', id)); } });
  });
}
// one write at a time per row, in order
function write(path, fn){
  setSync('Menyimpan…');
  const p = (QUEUE[path] || Promise.resolve()).then(fn).then(r => { if (r && r.error) throw r.error; }).catch(writeErr);
  QUEUE[path] = p;
  p.then(() => { if (QUEUE[path] === p) { delete QUEUE[path]; if (!Object.keys(QUEUE).length) setSync(); } });
}
let RELOAD_T;
function writeErr(e){
  const msg = (e && e.message) || '';
  if ((e && e.code) === '42501' || /row-level security/i.test(msg)) toast('Perubahan ditolak: akses kamu tidak mengizinkan ini.');
  else toast('Gagal menyimpan. Cek koneksi internet lalu ulangi.' + (msg ? ' (' + msg + ')' : ''));
  // show what the database really holds again
  clearTimeout(RELOAD_T); RELOAD_T = setTimeout(() => loadAll().then(render).catch(() => {}), 500);
}
function setSync(txt){
  const el = document.getElementById('syncState'); if (!el) return;
  el.textContent = (ME ? (ME.name || ME.email) + ' · ' : '') + (ROLE ? ROLE_LABEL[ROLE] + ' · ' : '') + (txt || (READY ? '● Tersinkron dengan tim' : 'Menghubungkan…'));
}
// a change from a teammate must not wipe what this person is typing
function remoteRender(){
  const a = document.activeElement;
  if (a && a.closest && a.closest('#view') && /INPUT|TEXTAREA/.test(a.tagName) && a.type !== 'checkbox' && a.value) { PENDING_RENDER = true; return; }
  render();
}
document.addEventListener('focusout', () => { if (PENDING_RENDER) { PENDING_RENDER = false; setTimeout(render, 150); } });

// ---- reading rows into the app state ----
function applyConfig(d){ if (!d) return; CFG_KEYS.forEach(k => { if (d[k]) S[k] = clone(d[k]); }); BASE.config = stable(cfgOf()); }
function putProject(id, v){
  v = clone(v); const done = v.done || {}, pre = id + '|'; delete v.done;
  Object.keys(S.doneManual).forEach(k => k.startsWith(pre) && delete S.doneManual[k]);
  Object.keys(done).forEach(k => S.doneManual[pre + k] = true);
  const i = S.projects.findIndex(p => p.id === id);
  if (i >= 0) S.projects[i] = v; else { S.projects.push(v); S.projects.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); }
  BASE.projects[id] = stable(projDoc(v));
}
function putDoc(col, id, v){
  if (col === 'projects') return putProject(id, v);
  v = clone(v); BASE[col][id] = stable(v);
  if (col === 'attendance') S.attendance[id] = v;
  else { const i = S[col].findIndex(x => x.id === id); if (i >= 0) S[col][i] = v; else S[col].push(v); }
}
function dropDoc(col, id){
  delete BASE[col][id];
  if (col === 'attendance') delete S.attendance[id];
  else { S[col] = S[col].filter(x => x.id !== id); if (col === 'projects') Object.keys(S.doneManual).forEach(k => k.startsWith(id + '|') && delete S.doneManual[k]); }
}
// Supabase returns at most 1000 rows per request, so page through bigger tables
async function fetchAll(make){
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
async function loadAll(){
  const rows = (t, f) => fetchAll(() => f(sb.from(t).select('id,data')));
  const [cfg, pr, pl, pa, at] = await Promise.all([
    sb.from('app_config').select('id,data').eq('id', 'main').maybeSingle(),
    rows('projects', q => q),
    rows('plots', q => q.gte('date', addDays(today(), -PLOT_WINDOW_DAYS))),
    rows('panels', q => q.gte('date', addDays(today(), -365))),
    rows('attendance', q => q),
  ]);
  if (cfg.error) throw cfg.error;
  S = emptyState(); BASE.config = null; COLS.forEach(c => BASE[c] = {});
  if (cfg.data) applyConfig(cfg.data.data);
  pr.forEach(r => putProject(r.id, r.data));
  pl.forEach(r => putDoc('plots', r.id, r.data));
  pa.forEach(r => putDoc('panels', r.id, r.data));
  at.forEach(r => putDoc('attendance', r.id, r.data));
}
function onChange(table, payload){
  if (!READY) return;
  const col = table === 'app_config' ? 'config' : table, row = payload.new, id = (row && row.id) || (payload.old && payload.old.id);
  if (col === 'config') { if (row && row.data && stable(row.data) !== BASE.config) { applyConfig(row.data); remoteRender(); } return; }
  if (payload.eventType === 'DELETE') { if (!(id in BASE[col])) return; dropDoc(col, id); }
  else { if (!row || !row.data || BASE[col][id] === stable(row.data)) return; putDoc(col, id, row.data); }   // equal = our own write coming back
  remoteRender();
}
function subscribeData(){
  const ch = sb.channel('dre-data');
  ['app_config', ...COLS].forEach(t => ch.on('postgres_changes', {event: '*', schema: 'public', table: t}, p => onChange(t, p)));
  ch.subscribe(status => { if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setSync('Sinkronisasi terputus. Muat ulang halaman.'); });
}

// ---- sign-in and roles ----
async function startData(){
  if (DATA_STARTED) return;
  DATA_STARTED = true;
  try { await loadAll(); }
  catch (e) { DATA_STARTED = false; setSync('Gagal memuat data'); toast('Gagal memuat data: ' + ((e && e.message) || e)); return; }
  READY = true; subscribeData(); setSync(); render();
}
async function loadPeople(){
  const { data } = await sb.from('profiles').select('id,email,name,role,created_at').order('created_at');
  PEOPLE = data || []; render();
}
async function loadMe(){
  const { data } = await sb.from('profiles').select('id,email,name,role').eq('id', SESSION.user.id).maybeSingle();
  ME = data || {id: SESSION.user.id, email: SESSION.user.email, name: '', role: 'pending'};
  const was = ROLE; ROLE = ME.role || 'pending';
  if (!canSee(UI.page)) UI.page = ROLE_PAGES[ROLE][0];
  if (was && was !== ROLE) toast('Akses kamu sekarang: ' + ROLE_LABEL[ROLE]);
  if (ROLE !== 'pending') startData();
  if (ROLE === 'master') loadPeople();
  setSync(); render();
}
async function afterLogin(session){
  if (SESSION) return;
  SESSION = session; UI.authMsg = ''; render();
  await loadMe();
  // your own role (and, for the master, everyone's) can change while the page is open
  sb.channel('dre-people').on('postgres_changes', {event: '*', schema: 'public', table: 'profiles'}, () => loadMe()).subscribe();
}
async function startAuth(){
  if (!sb) { document.getElementById('view').innerHTML = '<div class="empty" style="margin-top:40px">Tidak bisa terhubung ke database. Cek koneksi internet lalu muat ulang halaman.</div>'; return; }
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { UI.authMode = 'recover'; render(); return; }
    if (event === 'SIGNED_OUT') { location.reload(); return; }
    if (session && !SESSION && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) setTimeout(() => afterLogin(session), 0);
  });
  const { data } = await sb.auth.getSession();
  if (data.session) afterLogin(data.session); else render();
}

const val = id => ((document.getElementById(id) || {}).value || '').trim();
function authMsg(m){
  const email = val('auEmail'), name = val('auName');
  UI.authMsg = m; render();
  const e = document.getElementById('auEmail'), n = document.getElementById('auName');
  if (e) e.value = email; if (n) n.value = name;
}
function authView(){
  const m = UI.authMode || 'login', msg = UI.authMsg ? `<div class="banner" style="margin:14px 0 0">${esc(UI.authMsg)}</div>` : '';
  const head = (title, sub) => `<div class="logo-mark"></div><h1>${title}</h1><div class="small muted">${sub}</div>`;
  if (m === 'recover') return `<div class="auth-wrap"><div class="card auth-card">${head('Buat password baru', 'Dit Reveille · Produksi')}
    <label class="f">Password baru</label><input type="password" id="auNew" autocomplete="new-password">
    <button class="btn pri" style="width:100%;justify-content:center;margin-top:16px" data-act="authSetPass">Simpan password</button>${msg}</div></div>`;
  const signup = m === 'signup';
  return `<div class="auth-wrap"><div class="card auth-card">${head(signup ? 'Daftar akun' : 'Masuk', 'Dit Reveille · Produksi')}
    ${signup ? '<label class="f">Nama</label><input type="text" id="auName" autocomplete="name" placeholder="mis. Prita">' : ''}
    <label class="f">Email</label><input type="email" id="auEmail" autocomplete="email">
    <label class="f">Password</label><input type="password" id="auPass" autocomplete="${signup ? 'new-password' : 'current-password'}" placeholder="${signup ? 'minimal 6 karakter' : ''}">
    <button class="btn pri" style="width:100%;justify-content:center;margin-top:16px" data-act="${signup ? 'authSignup' : 'authLogin'}">${signup ? 'Daftar' : 'Masuk'}</button>
    <div class="auth-links">${signup ? '<button class="linkbtn" data-act="authMode" data-v="login">Sudah punya akun? Masuk</button>'
      : '<button class="linkbtn" data-act="authMode" data-v="signup">Belum punya akun? Daftar</button><button class="linkbtn" data-act="authForgot">Lupa password?</button>'}</div>
    ${msg}</div></div>`;
}
function pendingView(){
  return `<div class="auth-wrap"><div class="card auth-card"><div class="logo-mark"></div><h1>Menunggu persetujuan</h1>
    <p class="muted">Akun <b>${esc((ME && ME.email) || '')}</b> sudah terdaftar. Minta admin memberi akses. Halaman ini terbuka otomatis setelah akses diberikan.</p>
    <button class="btn" data-act="logout">Keluar</button></div></div>`;
}
function pendingBanner(){
  const n = ROLE === 'master' ? PEOPLE.filter(p => p.role === 'pending').length : 0;
  return n && UI.page !== 'settings' ? `<div class="banner">🔔 <b>${n} akun baru</b> menunggu persetujuan.<div class="grow"></div><button class="btn sm" data-act="page" data-page="settings">Atur akses</button></div>` : '';
}
