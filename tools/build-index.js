// Builds index.html (the Supabase / Vercel version) from dre-tim.html (the claude.ai version).
// Usage: node tools/build-index.js
// The two share all screens; only storage, sign-in and access management differ.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let h = fs.readFileSync(path.join(root, 'dre-tim.html'), 'utf8').replace(/\r\n/g, '\n');

const fail = msg => { console.error('build-index: ' + msg); process.exit(1); };
const replaceOnce = (o, n) => {
  const c = h.split(o).length - 1;
  if (c !== 1) fail(`expected 1 match, found ${c}: ${JSON.stringify(o.slice(0, 70))}`);
  h = h.replace(o, () => n);
};
const replaceBetween = (start, end, n) => {
  const i = h.indexOf(start), j = h.indexOf(end, i);
  if (i < 0 || j < 0 || h.indexOf(start, i + 1) >= 0) fail('block not found: ' + JSON.stringify(start.slice(0, 60)));
  h = h.slice(0, i) + n + h.slice(j + end.length);
};

// ---------- page skeleton (claude.ai adds one itself; Vercel serves the file as is) ----------
h = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
` + h;
replaceOnce('</style>\n<div class="app">',
  '</style>\n<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"></script>\n</head>\n<body>\n<div class="app">');
h = h.replace(/<\/script>\s*$/, '</script>\n</body>\n</html>\n');

// ---------- styles for sign-in screens ----------
replaceOnce('@keyframes fade{from{opacity:0}}', `[hidden]{display:none!important}
input[type=email],input[type=password]{border:1px solid var(--line);background:#fff;border-radius:8px;padding:8px 10px;width:100%;outline:none}
.auth-wrap{min-height:85vh;display:grid;place-items:center}
.auth-card{width:min(400px,100%);padding:26px}
.auth-card .logo-mark{width:44px;height:44px;border-radius:12px}
.auth-card h1{font-size:21px;margin:14px 0 2px}
.auth-card label.f{margin-top:12px}
.auth-links{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:14px;font-size:13px}
.app.signed-out .nav{display:none}
.app.signed-out main{padding-bottom:22px}
.nav-logout{margin-top:auto}.nav-logout+.nav-foot{margin-top:0}
@keyframes fade{from{opacity:0}}`);

// ---------- navigation: sign-out button ----------
replaceOnce('    <div class="nav-foot" id="syncState">Menghubungkan…</div>',
  '    <button class="nav-btn nav-logout" data-act="logout"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4"/></svg>Keluar</button>\n    <div class="nav-foot" id="syncState">Menghubungkan…</div>');

// ---------- storage: Supabase instead of the claude.ai database ----------
replaceBetween('/* ============ STORAGE ============', "  claude.use('downloads').then(d => DL = d);\n}\n", fs.readFileSync(path.join(__dirname, 'supabase-storage.js'), 'utf8'));

// ---------- render: sign-in / waiting screens, pending-account banner ----------
replaceOnce("  document.querySelectorAll('.nav-btn').forEach(b => { b.classList.toggle('on', b.dataset.page === UI.page); b.hidden = !!ROLE && !canSee(b.dataset.page); });",
  "  document.querySelectorAll('.nav-btn').forEach(b => { b.classList.toggle('on', b.dataset.page === UI.page); if (b.dataset.page) b.hidden = !!ROLE && !canSee(b.dataset.page); });");
replaceOnce("  document.getElementById('view').innerHTML = !READY || !ROLE\n    ? `<div class=\"empty\" style=\"margin-top:40px\">Memuat data produksi tim…</div>`\n    : (CAN_WRITE || ROLE === 'viewer' ? '' : `<div class=\"banner\">👀 Kamu membuka dalam mode lihat saja. Minta pemilik memberi akses <b>Contributor</b> supaya bisa mengubah plotting.</div>`) + PAGES[UI.page]();",
  "  const out = !SESSION || UI.authMode === 'recover', loading = `<div class=\"empty\" style=\"margin-top:40px\">Memuat data produksi tim…</div>`;\n  document.querySelector('.app').classList.toggle('signed-out', out || ROLE === 'pending');\n  document.getElementById('view').innerHTML = out ? authView() : !ROLE ? loading : ROLE === 'pending' ? pendingView() : !READY ? loading : pendingBanner() + PAGES[UI.page]();");
replaceBetween('  fillNames();\n}\n// names are resolved live from user ids (never stored)\nfunction fillNames(){', "e.textContent = (ps[e.dataset.uname] || {}).name || 'Orang tanpa nama'; }));\n}", '}');

// ---------- settings: access table from Supabase profiles ----------
replaceBetween("    ${ROLE === 'master' && IN_VIEWER ? `<div class=\"card\" style=\"grid-column:1/-1\"><h2>Akses tim</h2>", "Hari Ini.</p></div>` : ''}\n",
`    \${ROLE === 'master' ? \`<div class="card" style="grid-column:1/-1"><h2>Akses tim</h2>
      <p class="small muted" style="margin-top:-4px">Setiap orang mendaftar sendiri lewat link aplikasi ini. Akun baru berstatus <b>Menunggu</b> dan tidak bisa melihat apa pun sampai kamu memilih aksesnya di sini.</p>
      <div class="scroll-x"><table class="tbl"><thead><tr><th>Nama</th><th>Email</th><th>Akses</th></tr></thead><tbody>
        \${PEOPLE.map(p => \`<tr\${p.role === 'pending' ? ' style="background:var(--amber-soft)"' : ''}><td><b>\${esc(p.name || '-')}</b>\${ME && p.id === ME.id ? ' <span class="badge">kamu</span>' : ''}</td><td class="small">\${esc(p.email || '')}</td>
          <td>\${ME && p.id === ME.id ? '<span class="badge b-live">Master admin</span>' : \`<select data-ch="roleSet" data-uid="\${esc(p.id)}" style="width:auto">\${ROLE_OPTS.map(([v, l]) => \`<option value="\${v}" \${p.role === v ? 'selected' : ''}>\${l}</option>\`).join('')}</select>\`}</td></tr>\`).join('')}
      </tbody></table></div></div>\` : ''}
`);
replaceOnce("${IN_VIEWER ? 'Data tersimpan online dan sama untuk semua anggota tim. Tetap download backup sesekali (mis. tiap Jumat) untuk jaga-jaga.' : 'Data disimpan di browser perangkat ini. Download backup secara rutin (mis. tiap Jumat), dan pakai \"Restore\" untuk memindahkan data ke laptop/HP lain.'}",
  'Data tersimpan online dan sama untuk semua anggota tim. Tetap download backup sesekali (mis. tiap Jumat) untuk jaga-jaga. Pakai "Restore" untuk memindahkan data dari versi claude.ai.');

// ---------- plotting: print works outside claude.ai ----------
replaceOnce("${IN_VIEWER ? '' : '<button class=\"btn sm no-print\" data-act=\"print\">🖨 Cetak</button>'}", '<button class="btn sm no-print" data-act="print">🖨 Cetak</button>');

// ---------- actions ----------
replaceOnce("  roleAdd: d => { ROLES[d.uid] = document.getElementById('roleNew').value; writeRoles(); },\n  roleDel: d => ask('Cabut akses orang ini? Dia akan kembali hanya bisa melihat Hari Ini.', 'Cabut akses', () => { delete ROLES[d.uid]; writeRoles(); }),\n",
`  authMode: d => { UI.authMode = d.v; UI.authMsg = ''; render(); },
  authLogin: async () => {
    const email = val('auEmail'), password = val('auPass');
    if (!email || !password) return authMsg('Isi email dan password dulu.');
    authMsg('Masuk…');
    const { error } = await sb.auth.signInWithPassword({email, password});
    if (error) authMsg(/invalid login/i.test(error.message) ? 'Email atau password salah.' : /not confirmed/i.test(error.message) ? 'Email belum dikonfirmasi. Cek kotak masuk email kamu.' : error.message);
  },
  authSignup: async () => {
    const name = val('auName'), email = val('auEmail'), password = val('auPass');
    if (!name || !email || !password) return authMsg('Isi nama, email, dan password.');
    if (password.length < 6) return authMsg('Password minimal 6 karakter.');
    authMsg('Mendaftarkan…');
    const { data, error } = await sb.auth.signUp({email, password, options: {data: {name}, emailRedirectTo: location.origin + location.pathname}});
    if (error) return authMsg(/registered/i.test(error.message) ? 'Email ini sudah terdaftar. Silakan masuk.' : error.message);
    if (!data.session) { UI.authMode = 'login'; authMsg('Akun dibuat. Cek email kamu dan klik link konfirmasi, lalu masuk di sini.'); }
  },
  authForgot: async () => {
    const email = val('auEmail');
    if (!email) return authMsg('Isi email kamu dulu, lalu klik "Lupa password?".');
    const { error } = await sb.auth.resetPasswordForEmail(email, {redirectTo: location.origin + location.pathname});
    authMsg(error ? error.message : 'Link untuk membuat password baru sudah dikirim ke email kamu.');
  },
  authSetPass: async () => {
    const password = val('auNew');
    if (password.length < 6) return authMsg('Password minimal 6 karakter.');
    const { error } = await sb.auth.updateUser({password});
    if (error) return authMsg(error.message);
    UI.authMode = 'login'; UI.authMsg = ''; toast('Password baru disimpan'); render();
  },
  logout: async () => { await sb.auth.signOut(); location.reload(); },
`);
replaceOnce("  roleSet: el => { ROLES[el.dataset.uid] = el.value; writeRoles(); },",
  "  roleSet: el => { sb.from('profiles').update({role: el.value}).eq('id', el.dataset.uid).then(({error}) => toast(error ? 'Gagal mengubah akses: ' + error.message : 'Akses diperbarui')); },");
replaceBetween('function searchPeople(q){', "    if (!box.children.length) box.innerHTML = '<div class=\"small muted\">Tidak ketemu. Pastikan namanya benar dan orangnya satu organisasi.</div>';\n  });\n}\n", '');
replaceOnce("\n  if (el.id === 'roleSearch') searchPeople(el.value);", '');
replaceOnce("  if (el.id === 'cTxt')", "  if (['auName', 'auEmail', 'auPass', 'auNew'].includes(el.id)) document.querySelector('.auth-card .btn.pri')?.click();\n  if (el.id === 'cTxt')");
replaceBetween('  if (IN_VIEWER) {\n    if (!DL)', "toast('Gagal download (' + e.code + ')'); });\n  }\n", '');

// ---------- start ----------
replaceOnce('render();\nsetSync();\n</script>', 'render();\nsetSync();\nstartAuth();\n</script>');

for (const leftover of ['IN_VIEWER', 'claude.use', 'writeRoles', 'ROLES', 'fillNames', 'USER.']) if (h.includes(leftover)) fail('leftover reference: ' + leftover);
fs.writeFileSync(path.join(root, 'index.html'), h);
console.log('index.html written (' + h.length + ' chars)');
