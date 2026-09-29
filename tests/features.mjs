// 新功能测试：本局随机潜质、人物现状、隐藏设定不给玩家看、剧本默认文风、旧性格迁移、划线收藏、固定开场。
// 用法：node tests/features.mjs [截图目录]
// 和 smoke.mjs 一样拦截 DeepSeek 接口，不需要真的密钥。
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

async function loadPlaywright() {
  let globalRoot = '';
  try { globalRoot = (await import('child_process')).execSync('npm root -g', { encoding: 'utf8' }).trim(); } catch {}
  for (const t of ['playwright', globalRoot && globalRoot + '/playwright/index.mjs'].filter(Boolean)) { try { return await import(t); } catch {} }
  throw new Error('找不到 playwright');
}
const { chromium } = await loadPlaywright();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(ROOT, 'index.html'));
const OUT = process.argv[2] || '';
const server = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(html); }).listen(0);
const port = server.address().port;
const sse = text => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: [DONE]\n\n';
const json = content => JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [], fails = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const check = (ok, msg) => { console.log((ok ? '  ✓ ' : '  ✗ ') + msg); if (!ok) fails.push(msg); };
let lastUser = '', lastSys = '';
await page.route('https://api.deepseek.com/**', async route => {
  const b = JSON.parse(route.request().postData() || '{}');
  const sys = b.messages?.[0]?.content || '', user = b.messages?.[b.messages.length - 1]?.content || '';
  if (!b.stream) return route.fulfill({ status: 200, contentType: 'application/json', body: json(sys.includes('剧情记录员') ? '摘要。' : '{"choices":["甲","乙","丙","丁"]}') });
  lastUser = user; lastSys = sys;
  const opening = user.includes('游戏开始');
  return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(`${opening ? '开场正文，雾很大。' : '回合正文。'}\n###STATE###\n${JSON.stringify({ choices: ['继续', '休息'] })}`) });
});
const W = (f, a) => page.evaluate(f, a);
await page.goto(`http://localhost:${port}/`);
await page.waitForTimeout(300);
await page.click('#btn-open-settings'); await page.fill('#set-apiKey', 'sk-test'); await page.click('text=保存设置'); await page.click('#v-settings [data-back]');

async function startGame(titlePart) {
  await page.click(`.script-card:has-text("${titlePart}") >> text=开始新游戏`); await page.waitForTimeout(250);
  if (!(await page.inputValue('#setup-name'))) await page.fill('#setup-name', '沈知微');
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__wenyou.G.save?.log.length === 1 && !window.__wenyou.G.busy, null, { timeout: 10000 });
}

console.log('【本局随机潜质】');
await startGame('斗罗');
const seeds = await W(() => {
  const st = window.__wenyou.G.save.state;
  const bad = st.characters.filter(c => (c.seeds || []).length !== ({ major: 2, supporting: 1, minor: 0 }[c.importance] ?? 1)).map(c => c.name);
  const all = st.characters.flatMap(c => c.seeds.map(x => x.seed));
  return { bad, n: all.length, uniq: new Set(all).size, sample: st.characters.find(c => c.seeds.length)?.seeds.map(x => x.seed) };
});
check(seeds.bad.length === 0, `主要人物 2 个、次要人物 1 个潜质（不符合的：${seeds.bad.join('、') || '无'}）`);
check(seeds.n > 0 && seeds.uniq === seeds.n, `一局之内不重复：${seeds.uniq}/${seeds.n}，例如 ${seeds.sample}`);
check(lastUser.includes('〔本局潜质'), '发给 AI 的人物卡里有本局潜质');
check(lastUser.includes('现状：'), '发给 AI 的人物卡里有现状');
const seedWords = await W(() => window.__wenyou.G.save.state.characters.flatMap(c => c.seeds.map(x => x.seed)));
await page.click('#btn-panel'); await page.click('#sheet-tabs >> text=人物'); await page.waitForTimeout(150);
const sheetText = await page.textContent('#sheet-body');
check(!seedWords.some(w => sheetText.includes(w)), '人物面板上看不到潜质');

console.log('【隐藏设定不给玩家看】');
const firstName = await W(() => window.__wenyou.G.save.state.characters.find(c => c.met !== false && c.motive).name);
const motiveBefore = await W(n => window.__wenyou.G.save.state.characters.find(c => c.name === n).motive, firstName);
await page.click(`#sheet-body .char:has-text("${firstName}")`); await page.waitForTimeout(150);
const labels = await page.$$eval('#modal-body label', els => els.map(e => e.textContent));
check(!labels.some(l => /立场与动机|过往经历|秘密/.test(l)), `编辑「${firstName}」时没有隐藏设定的输入框`);
check(labels.some(l => l.includes('现状')), '编辑人物时可以改现状');
await page.click('#modal-foot >> text=保存'); await page.waitForTimeout(150);
const motiveAfter = await W(n => window.__wenyou.G.save.state.characters.find(c => c.name === n).motive, firstName);
check(motiveBefore === motiveAfter && !!motiveAfter, '保存人物后隐藏设定保持原样');
await page.click('#sheet-close');

console.log('【现状与结识】');
const r1 = await W(() => {
  const { G, applyDelta, buildUserPrompt } = window.__wenyou; const sv = G.save, st = sv.state;
  const x = st.characters.find(c => c.met === false);
  applyDelta(sv, { characters: [{ name: x.name, now: '测试现状：去了天斗城' }] }, 1);
  const a = { now: x.now, met: x.met };
  applyDelta(sv, { characters: [{ name: x.name, opinion: '觉得主角有点意思' }] }, 1);
  return { name: x.name, a, metAfter: x.met, inPrompt: buildUserPrompt(sv, '测试').includes('测试现状：去了天斗城') };
});
check(r1.a.now === '测试现状：去了天斗城' && r1.a.met === false, `只更新现状，${r1.name} 仍然没结识`);
check(r1.metAfter === true, '有了看法以后算结识');
check(r1.inPrompt, '新的现状发给了 AI');

console.log('【潜质定下内容、被发现】');
const r2 = await W(() => {
  const { G, applyDelta, buildUserPrompt } = window.__wenyou; const sv = G.save, st = sv.state;
  const m = st.characters.find(c => c.seeds.length === 2 && c.met !== false);
  const s0 = m.seeds[0].seed;
  applyDelta(sv, { characters: [{ name: m.name, seeds: [{ seed: s0, text: '具体内容甲' }] }] }, 2);
  applyDelta(sv, { characters: [{ name: m.name, seeds: [{ seed: s0, text: '具体内容乙' }] }] }, 3);
  const fixed = m.seeds[0].text;
  const before = buildUserPrompt(sv, '测试').includes('具体内容甲');
  applyDelta(sv, { characters: [{ name: m.name, reveal: [{ title: '测试词条', text: '具体内容甲', seed: s0 }] }] }, 4);
  const t = m.traits.find(x => x.title === '测试词条');
  const line = buildUserPrompt(sv, '测试').split('\n').find(l => l.includes('〔本局潜质') && l.includes(m.seeds[1].seed)) || '';
  return { fixed, before, traitSeed: t?.seed === s0, revealed: m.seeds[0].revealed === true, stillHidden: line.includes(s0) };
});
check(r2.fixed === '具体内容甲', '潜质的内容定下来以后不再改');
check(r2.before, '定下的内容发给了 AI');
check(r2.traitSeed && r2.revealed, '被发现后成为词条，并标为已揭示');
check(!r2.stillHidden, '已揭示的潜质不再列在隐藏部分');

console.log('【剧本默认文风】');
const r3 = await W(() => {
  const { G, S, buildSystemPrompt, resolveStyle } = window.__wenyou; const sv = G.save;
  const sp = buildSystemPrompt(sv);
  const s = S(); const keep = s.scriptPrefs[sv.scriptId];
  s.scriptPrefs[sv.scriptId] = { style: { id: 'script', name: '剧本默认文风', text: '旧的文风：短句为主，用词朴素。' } };
  const stale = resolveStyle(sv);
  if (keep) s.scriptPrefs[sv.scriptId] = keep; else delete s.scriptPrefs[sv.scriptId];
  return { hasStyle: sp.includes('【文风'), words: ['平实', '潜台词', '让读者', '短句为主', '用词朴素', '话中话'].filter(w => sp.includes(w)), stale, style: sv.script.style };
});
check(r3.style === '' && !r3.hasStyle, '斗罗剧本没有默认文风，系统提示里没有【文风】');
check(r3.words.length === 0, `系统提示里没有写法要求（找到：${r3.words.join('、') || '无'}）`);
check(r3.stale === null, '旧设置里存着的旧剧本文风不再生效');

console.log('【旧存档迁移】');
const r4 = await W(() => {
  const { G, migrateSave } = window.__wenyou; const sv = JSON.parse(JSON.stringify(G.save));
  sv.state.persona = '好胜心强，最讨厌被人看不起，说话有时带刺。输了会憋着一口气去练。别人对她好，她会一直记着。';
  for (const c of sv.state.characters) delete c.seeds;
  sv.snapshots = [{ turn: 0, state: JSON.parse(JSON.stringify(sv.state)) }];
  migrateSave(sv);
  const cur = sv.state.characters.find(c => c.importance === 'major'), snap = sv.snapshots[0].state.characters.find(c => c.name === cur.name);
  return { persona: sv.state.persona, dealt: sv.state.characters.every(c => Array.isArray(c.seeds)), same: JSON.stringify(cur.seeds) === JSON.stringify(snap.seeds), n: cur.seeds.length };
});
check(r4.persona.startsWith('好胜心强，讨厌被人看不起'), '旧版性格文字换成新版');
check(r4.dealt && r4.n === 2 && r4.same, '旧存档补上潜质，回退快照里是同一组');

console.log('【划线收藏】');
await W(() => {
  const p = document.querySelector('#log .entry .narr p');
  const r = document.createRange(); r.setStart(p.firstChild, 0); r.setEnd(p.firstChild, 4);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
});
await page.waitForTimeout(200);
check(await page.isVisible('.mark-btn'), '选中正文后出现“划线收藏”');
await page.tap('.mark-btn'); await page.waitForTimeout(300);
const m1 = await W(() => ({ n: window.__wenyou.marks().length, text: window.__wenyou.marks()[0]?.text, hl: document.querySelectorAll('#log mark.hl').length }));
check(m1.n === 1 && m1.text === '开场正文', `收藏了“${m1.text}”`);
check(m1.hl > 0, '正文里显示划线');
if (OUT) await page.screenshot({ path: path.join(OUT, 'feature-mark.png') });
await page.click('#btn-panel'); await page.click('#sheet-tabs >> text=摘录'); await page.waitForTimeout(150);
check((await page.$$('#sheet-body .mark-card')).length === 1, '摘录页有这一条');
if (OUT) await page.screenshot({ path: path.join(OUT, 'feature-marks-tab.png') });
await page.click('#sheet-close');
await page.click('#btn-leave'); await page.waitForTimeout(200);
await page.reload(); await page.waitForTimeout(500);
check(await page.isVisible('text=我的摘录'), '书架上有“我的摘录”（刷新后还在）');
await page.click('text=我的摘录'); await page.waitForTimeout(150);
check((await page.$$('#modal-body .mark-card')).length === 1, '全部摘录里有这一条');
await page.click('#modal-body .mark-card >> text=删除'); await page.click('#modal-body .mark-card >> text=确定删除'); await page.waitForTimeout(200);
check(await W(() => window.__wenyou.marks().length === 0), '可以删除');
await page.click('#modal-foot >> text=关闭');

console.log('【全文】');
await page.click('.save-item:has-text("第")'); await page.waitForTimeout(300);
await page.click('#btn-panel'); await page.click('#sheet-tabs >> text=全文'); await page.waitForTimeout(150);
check((await page.$$('#sheet-body .full-turn')).length >= 1, '全文页按回合列出剧情');
await page.fill('#sheet-body input[type=search]', '雾很大'); await page.waitForTimeout(350);
check((await page.$$('#sheet-body mark.q')).length === 1, '搜索能找到并高亮');
await page.fill('#sheet-body input[type=search]', '没有这个词'); await page.waitForTimeout(350);
check((await page.$$('#sheet-body .full-turn')).length === 0, '搜不到时没有结果');
await page.fill('#sheet-body input[type=search]', '雾很大'); await page.waitForTimeout(350);
await page.click('#sheet-body .full-turn >> text=引用'); await page.waitForTimeout(200);
check((await page.inputValue('#action')).includes('前情提醒：开场'), '引用会放进行动输入框');
await page.fill('#action', '');
await page.click('#btn-leave'); await page.waitForTimeout(200);

console.log('【固定开场的剧本】');
await startGame('雾港');
check(!lastUser.includes('这次开场的情境'), '雾港来信的开场不再随机抽情境');
check(lastUser.includes('沈兰'), '开场要求里有【开端】那一幕');

console.log('\n页面报错：', errors.length ? errors : '无');
await browser.close(); server.close();
if (fails.length || errors.length) { console.log(`失败 ${fails.length} 项`); process.exit(1); }
console.log('全部通过');
