const express = require('express');
const https   = require('https');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

const WB_API_KEY  = process.env.WB_API_KEY  || '';
const SALES_DAYS  = parseInt(process.env.SALES_DAYS  || '93');
const TARGET_DAYS = parseInt(process.env.TARGET_DAYS || '60');
const MIN_BATCH   = parseInt(process.env.MIN_BATCH   || '10');

const FABRIC_MAP = {
  'Пижамы':'Хлопок / Вискоза','Костюмы':'Хлопок / Муслин',
  'Топы':'Хлопок рибана','Леггинсы':'Трикотаж',
  'Ночные сорочки':'Вискоза / Шёлк','Туники':'Вискоза / Лён',
  'Майки бельевые':'Хлопок рибана','Лонгсливы':'Хлопок рибана',
  'Халаты домашние':'Вискоза / Шёлк','Шорты':'Хлопок',
  'Платья':'Вискоза','Юбки':'Муслин','Брюки':'Трикотаж',
  'Боди':'Хлопок рибана','Футболки':'Хлопок','Резинки':'Аксессуары',
};

const DEFAULT_WITHDRAW = [
  'пижама_Афина_черная','пижама_Афина_оливка','пижама_Афина_белая','пижама_Афина_шоколад',
  'костюм_Home_Черный','костюм_Home_Шоколад','КостюмЛайм',
  'SunMilk','SunBlack','SunCacao','SunGray','SunBarbie',
  'pajamasCacao','pajamasMilk','pajamasGrey','pajamasBarbie','pajamasPink','pajamasBlack','pajamasLavender',
  'T-shirtMilk','РубашкаИшортыСердечки','РубашкаИшортыКантРозовый','РубашкаИшортыРозовый',
  'ПижамаВискозаГрафит','ПижамаВискозаШоколад','ПижамаВискозаСиний','ПижамаВискозаМеланж',
  'халат_Грэйс_черный','халат_Грэйс_шоколад','DenimSky','Пионы2в1',
];

let cache = { data: null, updated: null, loading: false };

// Находим папку с index.html автоматически
function findStaticDir() {
  const candidates = ['public', 'static', 'публичный', 'общественный'];
  for (const name of candidates) {
    const p = path.join(__dirname, name);
    if (fs.existsSync(p) && fs.existsSync(path.join(p, 'index.html'))) {
      console.log('Папка со статикой найдена: ' + name);
      return p;
    }
  }
  // ищем любую папку с index.html
  try {
    const dirs = fs.readdirSync(__dirname).filter(f => {
      try {
        return fs.statSync(path.join(__dirname, f)).isDirectory()
          && f !== 'node_modules' && !f.startsWith('.');
      } catch(e) { return false; }
    });
    for (const d of dirs) {
      if (fs.existsSync(path.join(__dirname, d, 'index.html'))) {
        console.log('Папка со статикой найдена: ' + d);
        return path.join(__dirname, d);
      }
    }
  } catch(e) {}
  console.log('Папка со статикой не найдена, используем public');
  return path.join(__dirname, 'public');
}

function wbGet(urlPath, params) {
  return new Promise((resolve, reject) => {
    const qs = Object.entries(params).map(([k,v]) => k+'='+encodeURIComponent(v)).join('&');
    const url = 'https://statistics-api.wildberries.ru/api/v1' + urlPath + '?' + qs;
    const req = https.get(url, { headers: { 'Authorization': WB_API_KEY } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('Неверный API-ключ (401)'));
        if (res.statusCode === 429) return reject(new Error('Лимит запросов WB (429)'));
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('Ошибка парсинга WB')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(45000, () => { req.destroy(); reject(new Error('Таймаут WB API')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function formatDate(d) { return d.toISOString().split('T')[0]; }

function processData(salesRaw, ordersRaw, stocksRaw, withdraw) {
  const pd = SALES_DAYS, tgt = TARGET_DAYS, mb = MIN_BATCH;
  const wdSet = new Set(withdraw);
  const salesMap = {}, ordMap = {}, stMap = {};

  (salesRaw || []).filter(r => (r.saleID||'').startsWith('S')).forEach(r => {
    const k = r.supplierArticle + '|' + r.techSize;
    if (!salesMap[k]) salesMap[k] = { sku:r.supplierArticle, size:r.techSize, cat:r.subject, sold:0, rev:0 };
    salesMap[k].sold += (r.quantity || 0);
    salesMap[k].rev  += (r.finishedPrice || 0);
  });

  (ordersRaw || []).forEach(r => {
    const k = r.supplierArticle + '|' + r.techSize;
    ordMap[k] = (ordMap[k] || 0) + (r.quantity || 0);
  });

  (stocksRaw || []).forEach(r => {
    const k = r.supplierArticle + '|' + r.techSize;
    if (!stMap[k]) stMap[k] = { wb:0, to:0, frm:0 };
    stMap[k].wb  += (r.quantityFull    || 0);
    stMap[k].to  += (r.inWayToClient   || 0);
    stMap[k].frm += (r.inWayFromClient || 0);
  });

  const rows = [];
  Object.values(salesMap).forEach(s => {
    if (s.sold <= 0) return;
    const k   = s.sku + '|' + s.size;
    const ord = ordMap[k] || s.sold;
    const conv = ord > 0 ? Math.min(s.sold / ord, 1) : 0;
    const spd  = s.sold / pd;
    const st   = stMap[k] || { wb:0, to:0, frm:0 };
    const eff  = Math.round((st.wb + st.frm + st.to * (1 - conv)) * 10) / 10;
    const days = spd > 0 ? Math.min(eff / spd, 999) : 999;
    const need = Math.max(0, Math.round(spd * tgt - eff));
    const batch = need > 0 ? Math.max(mb, Math.round(need / mb) * mb) : 0;
    rows.push({
      sku:s.sku, size:s.size, cat:s.cat,
      sold:s.sold, rev:Math.round(s.rev),
      conv:Math.round(conv*100)/100,
      spd:Math.round(spd*1000)/1000,
      wb:st.wb, to:st.to, frm:st.frm,
      eff, days:Math.round(days*10)/10,
      need, batch,
      fabric: FABRIC_MAP[s.cat] || 'Уточнить',
      wd: wdSet.has(s.sku),
    });
  });

  const catMap = {};
  rows.filter(r => !r.wd).forEach(r => {
    if (!catMap[r.cat]) catMap[r.cat] = { cat:r.cat, pos:0, sold:0, rev:0, wb:0, eff:0, spd:0, need:0, conv:0 };
    const c = catMap[r.cat];
    c.pos++; c.sold+=r.sold; c.rev+=r.rev; c.wb+=r.wb;
    c.eff+=r.eff; c.spd+=r.spd; c.need+=r.need; c.conv+=r.conv;
  });
  const cats = Object.values(catMap).map(c => ({
    ...c,
    conv: Math.round(c.conv / c.pos * 100) / 100,
    days: c.spd > 0 ? Math.round(Math.min(c.eff / c.spd, 999)) : 999,
  })).sort((a,b) => b.sold - a.sold);
  const totRev = cats.reduce((a,c) => a + c.rev, 0);
  cats.forEach(c => c.share = Math.round(c.rev / totRev * 10) / 10);

  const active = rows.filter(r => !r.wd);
  return {
    rows, cats, withdraw,
    summary: {
      active:   active.length,
      wb_stock: active.reduce((a,r) => a + r.wb, 0),
      eff:      Math.round(active.reduce((a,r) => a + r.eff, 0)),
      need:     active.reduce((a,r) => a + r.need, 0),
      zero:     active.filter(r => r.days === 0).length,
      critical: active.filter(r => r.days < 14).length,
      conv:     Math.round(active.reduce((a,r) => a+r.conv,0) / Math.max(active.length,1) * 100) / 100,
      revenue:  active.reduce((a,r) => a + r.rev, 0),
      n_wd:     rows.filter(r => r.wd).length,
      updated:  new Date().toISOString(),
    }
  };
}

async function fetchData() {
  if (!WB_API_KEY) throw new Error('WB_API_KEY не задан');
  cache.loading = true;
  try {
    const today     = new Date();
    const dateFrom  = formatDate(new Date(today - SALES_DAYS * 864e5));
    const dateTo    = formatDate(today);
    const yesterday = formatDate(new Date(today - 864e5));

    console.log('Загружаю продажи...');
    const salesRaw = await wbGet('/supplier/sales', { dateFrom, dateTo, flag: 1 });
    console.log('Продаж: ' + salesRaw.length);
    await sleep(700);

    console.log('Загружаю заказы...');
    const ordersRaw = await wbGet('/supplier/orders', { dateFrom, dateTo, flag: 1 });
    console.log('Заказов: ' + ordersRaw.length);
    await sleep(700);

    console.log('Загружаю остатки...');
    const stocksRaw = await wbGet('/supplier/stocks', { dateFrom: yesterday });
    console.log('Остатков: ' + stocksRaw.length);

    const result = processData(salesRaw, ordersRaw, stocksRaw, loadWithdraw());
    cache.data    = result;
    cache.updated = new Date().toISOString();
    console.log('Данные обновлены успешно');
    return result;
  } finally {
    cache.loading = false;
  }
}

const WITHDRAW_FILE = path.join(__dirname, '.data', 'withdraw.json');

function loadWithdraw() {
  try {
    if (fs.existsSync(WITHDRAW_FILE)) return JSON.parse(fs.readFileSync(WITHDRAW_FILE, 'utf8'));
  } catch(e) {}
  return DEFAULT_WITHDRAW;
}

function saveWithdraw(list) {
  const dir = path.dirname(WITHDRAW_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(WITHDRAW_FILE, JSON.stringify(list), 'utf8');
}

app.use(express.json());
app.use(express.static(findStaticDir()));

app.get('/api/data', (req, res) => {
  if (!cache.data) return res.json({ status: 'empty', message: 'Нажмите Обновить' });
  res.json({ status: 'ok', ...cache.data, is_loading: cache.loading });
});

app.post('/api/refresh', async (req, res) => {
  if (cache.loading) return res.json({ status: 'loading' });
  fetchData().catch(e => console.error('Ошибка:', e.message));
  res.json({ status: 'ok' });
});

app.get('/api/status', (req, res) => {
  res.json({ has_data: !!cache.data, is_loading: cache.loading, updated: cache.updated, api_key_set: !!WB_API_KEY });
});

app.get('/api/withdraw', (req, res) => res.json({ list: loadWithdraw() }));

app.post('/api/withdraw', (req, res) => {
  const list = req.body.list || [];
  saveWithdraw(list);
  if (cache.data) {
    const s = new Set(list);
    cache.data.rows.forEach(r => r.wd = s.has(r.sku));
    cache.data.withdraw = list;
  }
  res.json({ status: 'ok', count: list.length });
});

app.listen(PORT, () => {
  console.log('Сервер запущен на порту ' + PORT);
  if (WB_API_KEY) {
    console.log('Запускаю загрузку данных...');
    fetchData().catch(e => console.error('Ошибка начальной загрузки:', e.message));
  }
});
