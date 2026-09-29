// 冒烟测试：每个内置剧本开一局、玩一回合；斗罗再测一次跳年推演和回退。
// 用法：node tests/smoke.mjs [截图目录]
// 需要 Playwright 和 Chromium。DeepSeek 接口被拦截并返回模拟回复，不需要真的密钥。
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

async function loadPlaywright() {
  let globalRoot = '';
  try { globalRoot = (await import('child_process')).execSync('npm root -g', { encoding: 'utf8' }).trim(); } catch {}
  const tries = ['playwright', globalRoot && globalRoot + '/playwright/index.mjs', '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs', '/usr/lib/node_modules/playwright/index.mjs', '/usr/local/lib/node_modules/playwright/index.mjs'].filter(Boolean);
  for (const t of tries) { try { return await import(t); } catch {} }
  throw new Error('找不到 playwright：npm i -D playwright，或者改 tests/smoke.mjs 里的路径');
}
const { chromium } = await loadPlaywright();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(ROOT, 'index.html'));
const OUT = process.argv[2] || '';
const server = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(html); }).listen(0);
const port = server.address().port;

const sse = text => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: [DONE]\n\n';
const json = content => JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
let skipNext = false;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
const page = await ctx.newPage();
const errors = [], fails = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const check = (ok, msg) => { console.log((ok ? '  ✓ ' : '  ✗ ') + msg); if (!ok) fails.push(msg); };

await page.route('https://api.deepseek.com/**', async route => {
  const b = JSON.parse(route.request().postData() || '{}');
  const sys = b.messages?.[0]?.content || '', user = b.messages?.[b.messages.length - 1]?.content || '';
  if (!b.stream) {
    if (sys.includes('世界推演员')) return route.fulfill({ status: 200, contentType: 'application/json', body: json('{"player":{"stats":{}},"characters":[{"name":"胡列娜","stats":{"level":55},"note":"十年里升到了五十多级"}]}') });
    if (sys.includes('剧情记录员')) return route.fulfill({ status: 200, contentType: 'application/json', body: json('剧情摘要。') });
    return route.fulfill({ status: 200, contentType: 'application/json', body: json('{"choices":["甲","乙","丙","丁"]}') });
  }
  const opening = user.includes('游戏开始');
  const delta = opening ? { choices: ['一', '二', '三'] } : skipNext ? { year: 11, choices: ['继续'] } : { choices: ['继续', '休息'] };
  skipNext = false;
  return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(`${opening ? '开场正文。' : '回合正文。'}\n###STATE###\n${JSON.stringify(delta)}`) });
});

await page.goto(`http://localhost:${port}/`);
await page.waitForTimeout(300);
await page.click('#btn-open-settings'); await page.fill('#set-apiKey', 'sk-test'); await page.click('text=保存设置'); await page.click('#v-settings [data-back]');
const titles = await page.$$eval('.script-card', els => els.map(e => e.querySelector('h3, .title, b')?.textContent || ''));
console.log('书架：', titles.join(' | '));

const W = f => page.evaluate(f);
for (const title of titles.filter(t => !t.includes('雾港'))) {
  console.log(`\n【${title}】`);
  await page.click(`.script-card:has-text("${title}") >> text=开始新游戏`); await page.waitForTimeout(250);
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__wenyou.G.save?.log.length === 1 && !window.__wenyou.G.busy, null, { timeout: 10000 });
  const s0 = await W(() => { const sv = window.__wenyou.G.save, st = sv.state; return { year: st.year, gender: st.stats.gender, age: st.stats.age, chars: st.characters.length, basic: st.characters.filter(c => c.gender && c.born !== null).length, charStats: (sv.script.charStats || []).length }; });
  check(Number.isFinite(s0.year), `有年份：${s0.year}`);
  check(s0.gender === '女', `主角性别：${s0.gender}，年龄：${s0.age}`);
  check(s0.basic === s0.chars, `人物都有性别和出生年份：${s0.basic}/${s0.chars}`);
  check(s0.charStats > 0, `剧本有人物基础栏：${s0.charStats} 项`);
  check(!!(await page.$('.choices')), '开场下面有选项');
  await page.click('.choice button >> nth=0');
  await page.waitForFunction(() => window.__wenyou.G.save.state.turn === 1 && !window.__wenyou.G.busy, null, { timeout: 10000 });
  check(true, '玩了一回合');
  if (title.includes('斗罗')) {
    skipNext = true;
    await page.click('.choice button >> nth=0');
    await page.waitForFunction(() => window.__wenyou.G.save.state.turn === 2 && !window.__wenyou.G.busy && window.__wenyou.G.save.log[2].evolve?.status === 'done', null, { timeout: 15000 });
    const s2 = await W(() => { const st = window.__wenyou.G.save.state, hu = st.characters.find(c => c.name === '胡列娜'); return { year: st.year, age: st.stats.age, huAge: st.year - hu.born, huLevel: hu.stats.level }; });
    check(s2.year === 11 && s2.huAge === 30 && s2.huLevel === 55, `跳了十年：第${s2.year}年，主角 ${s2.age} 岁，胡列娜 ${s2.huAge} 岁、${s2.huLevel} 级`);
    await page.click('.tools >> text=回退'); await page.click('#modal-foot >> text=回退'); await page.waitForTimeout(300);
    const s3 = await W(() => { const st = window.__wenyou.G.save.state, hu = st.characters.find(c => c.name === '胡列娜'); return { year: st.year, huLevel: hu.stats.level, gender: st.stats.gender }; });
    check(s3.year === 1 && s3.huLevel === 37 && s3.gender === '女', `回退后回到第${s3.year}年，胡列娜 ${s3.huLevel} 级，性别 ${s3.gender}`);
  }
  if (OUT) await page.screenshot({ path: path.join(OUT, `smoke-${title.replace(/\W+/g, '')}.png`) });
  await page.click('#btn-leave'); await page.waitForTimeout(250);
}

console.log('\n页面报错：', errors.length ? errors : '无');
await browser.close(); server.close();
if (fails.length || errors.length) { console.log(`失败 ${fails.length} 项`); process.exit(1); }
console.log('全部通过');
