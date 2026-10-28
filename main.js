const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path'), fs = require('fs'), crypto = require('crypto');
const UA = { 'User-Agent': 'EmeraldLauncher/0.1' };
const OS = { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform];
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

const sf = () => path.join(app.getPath('userData'), 'store.json');
const load = () => { try { return JSON.parse(fs.readFileSync(sf())); } catch { return { users: {}, settings: { scale: 1, fit: 'cover' } }; } };
const save = s => { fs.mkdirSync(path.dirname(sf()), { recursive: true }); fs.writeFileSync(sf(), JSON.stringify(s)); };
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const J = async u => (await fetch(u, { headers: UA })).json();
const put = (p, b) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); };
const pub = (u, l) => ({ login: l, nick: u.nick });
const H = (c, f) => ipcMain.handle(c, (e, ...a) => f(...a));

function allowed(rules) {
  if (!rules) return true;
  let ok = false;
  for (const r of rules) {
    if (r.features) continue;
    if (!r.os || r.os.name === OS) ok = r.action === 'allow';
  }
  return ok;
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

app.whenReady().then(() => {
  const w = new BrowserWindow({
    width: 1100, height: 680, minWidth: 900, minHeight: 560, autoHideMenuBar: true,
    backgroundColor: '#0b1410', webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  w.loadFile('index.html');
});

// ---- аккаунты (локально) ----
H('reg', (l, p, email) => {
  const s = load();
  if (!/^\w{3,16}$/.test(l)) return { err: 'Логин: 3–16 символов (буквы, цифры, _)' };
  if (!p || p.length < 4) return { err: 'Пароль: минимум 4 символа' };
  if (s.users[l]) return { err: 'Такой логин уже занят' };
  const salt = crypto.randomBytes(8).toString('hex');
  s.users[l] = { salt, hash: hash(p, salt), nick: l, email: email || '' };
  s.current = l; save(s);
  return { user: pub(s.users[l], l) };
});
H('login', (l, p) => {
  const s = load(), u = s.users[l];
  if (!u || u.hash !== hash(p || '', u.salt)) return { err: 'Неверный логин или пароль' };
  s.current = l; save(s);
  return { user: pub(u, l) };
});
H('me', () => { const s = load(), u = s.users[s.current]; return u ? pub(u, s.current) : null; });
H('logout', () => { const s = load(); delete s.current; save(s); });
H('setNick', n => {
  if (!/^\w{3,16}$/.test(n)) return { err: 'Ник: 3–16 символов (буквы, цифры, _)' };
  const s = load(); s.users[s.current].nick = n; save(s); return { nick: n };
});

// ---- настройки ----
H('settings', () => load().settings);
H('setSettings', o => { const s = load(); s.settings = { ...s.settings, ...o }; save(s); });
H('pickBg', async () => {
  const r = await dialog.showOpenDialog({ filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
  return r.canceled ? null : r.filePaths[0];
});

// ---- скин, версии, каталог ----
H('skin', async n => {
  try {
    const r = await fetch('https://minotar.net/skin/' + encodeURIComponent(n), { headers: UA });
    return 'data:image/png;base64,' + Buffer.from(await r.arrayBuffer()).toString('base64');
  } catch { return null; }
});
H('versions', async () => (await J(MANIFEST)).versions.filter(v => v.type === 'release'));
H('search', async (type, q) => {
  const f = encodeURIComponent(JSON.stringify([[`project_type:${type}`]]));
  return (await J(`https://api.modrinth.com/v2/search?query=${encodeURIComponent(q || '')}&facets=${f}&limit=24`)).hits;
});

// ---- скачивание настоящей версии с серверов Mojang ----
ipcMain.handle('download', async (e, id) => {
  try {
    const root = path.join(app.getPath('appData'), '.emerald'), tasks = [];
    const v = (await J(MANIFEST)).versions.find(x => x.id === id), j = await J(v.url);
    put(path.join(root, 'versions', id, id + '.json'), JSON.stringify(j));
    tasks.push([j.downloads.client.url, path.join(root, 'versions', id, id + '.jar')]);
    for (const l of j.libraries || []) {
      if (!allowed(l.rules)) continue;
      const d = l.downloads || {};
      if (d.artifact) tasks.push([d.artifact.url, path.join(root, 'libraries', d.artifact.path)]);
      const c = l.natives && l.natives[OS];
      if (c && d.classifiers) {
        const a = d.classifiers[c.replace('${arch}', '64')];
        if (a) tasks.push([a.url, path.join(root, 'libraries', a.path)]);
      }
    }
    const ai = await J(j.assetIndex.url);
    put(path.join(root, 'assets', 'indexes', j.assetIndex.id + '.json'), JSON.stringify(ai));
    for (const o of Object.values(ai.objects)) {
      const h2 = o.hash.slice(0, 2);
      tasks.push([`https://resources.download.minecraft.net/${h2}/${o.hash}`, path.join(root, 'assets', 'objects', h2, o.hash)]);
    }
    let done = 0;
    await pool(tasks, 16, async ([u, d]) => {
      if (!fs.existsSync(d)) {
        const r = await fetch(u);
        if (!r.ok) throw Error('HTTP ' + r.status + ' ' + u);
        put(d, Buffer.from(await r.arrayBuffer()));
      }
      e.sender.send('progress', { done: ++done, total: tasks.length });
    });
    return { ok: 1 };
  } catch (x) { return { err: String(x.message || x) }; }
});
