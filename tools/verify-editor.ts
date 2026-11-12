// Two devices on one booklet, in a real browser (src/editor/useBooklet.ts):
//  - opening the booklet saves nothing, so idle devices never make each
//    other reload;
//  - a change on one device reaches the other in place (no reload);
//  - a date set for a later day survives a reload;
//  - a change made while saves fail is kept and saved once they work again,
//    also after the tab was closed meanwhile;
//  - a change made just before the tab closes is not lost.
// Run after `npm run build`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';

const port = '23511', origin = `http://127.0.0.1:${port}`, data = 'work/editor-data';
await rm(data, { recursive: true, force: true });
const server = spawn(process.execPath, ['build/server.js'], { env: { ...process.env, NODE_ENV: 'production', PORT: port, DATA_DIR: data, GITHUB_STORAGE_TOKEN: '' }, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100 && !(await fetch(`${origin}/api/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(200);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const stored = async () => (await (await fetch(`${origin}/api/booklet`)).json()) as { date: string } | null;

let saves = 0;
const open = async (context: BrowserContext) => {
  const page = await context.newPage();
  page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/api/booklet')) saves++; });
  await page.goto(origin);
  await page.waitForSelector('input[type=date]');
  return page;
};
const dateOf = (page: Page) => page.inputValue('input[type=date]');
const check = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
const until = async (what: string, test: () => Promise<boolean>, seconds = 15) => {
  console.log(`… ${what}`);
  for (let i = 0; i < seconds * 5; i++) { if (await test().catch(() => false)) return; await sleep(200); }
  throw new Error(`Timed out: ${what}`);
};

try {
  const laptop = await browser.newContext(), phone = await browser.newContext();
  const a = await open(laptop);
  // A first change, so the server has a booklet.
  await a.fill('input[type=date]', '2027-01-10');
  await until('the first save', async () => (await stored())?.date === '2027-01-10');
  const b = await open(phone);
  let loads = 0;
  a.on('load', () => loads++); b.on('load', () => loads++);
  saves = 0;
  // ---- idle devices: no saves, no reloads ----
  for (let i = 0; i < 4; i++) { await check(a); await check(b); await sleep(700); }
  assert.equal(saves, 0, 'opening and checking save nothing');
  assert.equal(loads, 0, 'idle devices never reload each other');
  // ---- a change on one reaches the other, in place ----
  await a.fill('input[type=date]', '2027-01-15');
  await until('the laptop saves', async () => (await stored())?.date === '2027-01-15');
  await check(b);
  await until('the phone takes the change', async () => (await dateOf(b)) === '2027-01-15');
  assert.equal(loads, 0, 'without reloading');
  // ---- a later date survives a reload ----
  await a.reload();
  await a.waitForSelector('input[type=date]');
  assert.equal(await dateOf(a), '2027-01-15', 'a date set for a later day is kept');
  assert.equal((await stored())?.date, '2027-01-15', 'and not reset on the server');
  // ---- saves failing: the change is kept, and saved once they work ----
  await a.route('**/api/booklet**', (route) => (route.request().method() === 'PUT' ? route.abort() : route.continue()));
  await a.fill('input[type=date]', '2027-01-20');
  await until('the label says the save is being retried', async () => /retrying/i.test(await a.textContent('.saved') ?? ''));
  await a.close();
  const a2 = await open(laptop);
  assert.equal(await dateOf(a2), '2027-01-20', 'the unsaved change opens again on this device');
  await until('and is saved now', async () => (await stored())?.date === '2027-01-20');
  // ---- a change just before the tab closes ----
  await a2.fill('input[type=date]', '2027-01-25');
  await sleep(150);
  await a2.close();
  const a3 = await open(laptop);
  assert.equal(await dateOf(a3), '2027-01-25', 'a change made just before closing is not lost');
  await until('and reaches the server', async () => (await stored())?.date === '2027-01-25');
  console.log('editor checks passed');
} finally {
  await browser.close();
  server.kill();
}
