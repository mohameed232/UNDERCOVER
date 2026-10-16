const { chromium } = require('playwright');
const assert = require('node:assert/strict');

const URL = process.env.UNDERCOVER_URL || 'http://127.0.0.1:8000';

async function noOverflow(page) {
  const widths = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert.ok(widths[0] <= widths[1], `horizontal overflow: ${widths.join(' > ')}`);
  assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
  const colors = await page.evaluate(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    primary: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
  }));
  assert.equal(colors.background, 'rgb(245, 243, 239)');
  assert.equal(colors.primary, '#4d6f7d');
}

async function testPassPlay(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(URL);
  await page.getByRole('button', { name: /جهاز واحد/ }).click();
  assert.equal(await page.locator('#hints').isChecked(), false);
  for (const [index, name] of ['آدم', 'سارة', 'ليان'].entries()) await page.locator('.player-input').nth(index).fill(name);
  await page.getByRole('button', { name: 'بدء الجولة الأولى' }).click();
  for (let index = 0; index < 3; index += 1) {
    await page.getByRole('button', { name: 'عرض الكلمة' }).click();
    const word = (await page.locator('.secret-word').textContent()).trim();
    await page.getByRole('button', { name: 'إخفاء والمتابعة' }).click();
    assert.equal(await page.locator('.secret-word').count(), 0);
    assert.ok(!(await page.locator('#screen').innerText()).includes(word));
  }
  assert.ok(await page.getByText('مرحلة الأسئلة المنظمة').isVisible());
  await noOverflow(page);
  assert.deepEqual(errors, []);
  await page.close({ runBeforeUnload: true });
}

async function testLocalParty(browser) {
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })));
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const errors = [];
  pages.forEach(page => page.on('pageerror', error => errors.push(error.message)));
  const names = ['ليان', 'سارة', 'عمر'];

  await pages[0].goto(`${URL}/party`);
  await pages[0].getByRole('button', { name: 'إنشاء غرفة' }).click();
  await pages[0].locator('#host-name').fill(names[0]);
  await pages[0].getByRole('button', { name: 'إنشاء الغرفة' }).click();
  const code = (await pages[0].locator('.room-code').textContent()).trim();
  assert.match(code, /^[A-Z2-9]{5}$/);

  for (let index = 1; index < pages.length; index += 1) {
    await pages[index].goto(`${URL}/party?room=${code}`);
    await pages[index].locator('#player-name').fill(names[index]);
    await pages[index].getByRole('button', { name: 'انضمام' }).click();
    await pages[index].locator('.room-code').waitFor();
  }
  await pages[0].getByRole('button', { name: 'بدء الجلسة' }).waitFor({ state: 'visible' });
  assert.equal(await pages[0].getByRole('button', { name: 'بدء الجلسة' }).isEnabled(), true);
  assert.equal(await pages[1].getByRole('button', { name: 'بدء الجلسة' }).count(), 0);
  await pages[0].getByRole('button', { name: 'بدء الجلسة' }).click();

  const totals = new Map(names.map(name => [name, 0]));
  const pairs = new Set();
  for (let round = 1; round <= 5; round += 1) {
    const secrets = new Map();
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      await page.getByRole('button', { name: 'عرض كلمتي' }).click();
      const word = (await page.locator('.secret-word').textContent()).trim();
      secrets.set(names[index], word);
      await page.getByRole('button', { name: 'إخفاء وأنا جاهز' }).click();
      assert.equal(await page.locator('.secret-word').count(), 0);
      await noOverflow(page);
    }
    const counts = new Map();
    for (const word of secrets.values()) counts.set(word, (counts.get(word) || 0) + 1);
    assert.equal(counts.size, 2);
    const majorityWord = [...counts].find(([, count]) => count === 2)[0];
    const undercoverWord = [...counts].find(([, count]) => count === 1)[0];
    const undercover = [...secrets].find(([, word]) => word === undercoverWord)[0];
    const key = [majorityWord, undercoverWord].sort().join('|');
    assert.ok(!pairs.has(key));
    pairs.add(key);

    await pages[0].getByRole('button', { name: 'بدء الأسئلة' }).click();
    await pages[0].locator('.assignment strong').first().waitFor();
    const askers = [];
    for (let question = 0; question < 3; question += 1) {
      const labels = await pages[0].locator('.assignment strong').allTextContents();
      assert.notEqual(labels[0], labels[1]);
      askers.push(labels[0]);
      await pages[0].getByRole('button', { name: question === 2 ? 'إنهاء الأسئلة' : 'السؤال التالي' }).click();
      if (question < 2) await pages[0].waitForFunction(previous => document.querySelector('.assignment strong')?.textContent !== previous, labels[0]);
      else await pages[0].getByText('النقاش الحر').waitFor();
    }
    assert.equal(new Set(askers).size, 3);
    await pages[0].getByRole('button', { name: 'بدء التصويت' }).click();
    for (const page of pages) {
      await page.locator('.vote-choice').filter({ hasText: undercover }).click();
      await page.getByRole('button', { name: 'تأكيد التصويت' }).click();
    }
    for (const name of names) totals.set(name, totals.get(name) + 1);
    const undercoverIndex = names.indexOf(undercover);
    await pages[undercoverIndex].getByRole('button', { name: majorityWord, exact: true }).click();
    totals.set(undercover, totals.get(undercover) + 1);

    await pages[0].locator('.score-table').waitFor();
    const rows = pages[0].locator('.score-table tbody tr');
    for (let index = 0; index < 3; index += 1) {
      const cells = await rows.nth(index).locator('td').allTextContents();
      assert.equal(Number(cells[2]), totals.get(cells[0]));
    }
    if (round === 1) {
      await pages[1].reload();
      await pages[1].locator('.score-table').waitFor();
      assert.equal((await pages[1].locator('.status-badge').textContent()).trim(), 'متصل');
    }
    await pages[0].getByRole('button', { name: round === 5 ? 'عرض النتيجة النهائية' : 'الجولة التالية' }).click();
  }
  assert.equal(pairs.size, 5);
  await pages[0].getByText('اكتملت الجولات الخمس').waitFor();
  assert.deepEqual(errors, []);
  await Promise.all(contexts.map(context => context.close()));
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  await testPassPlay(browser);
  await testLocalParty(browser);
  await browser.close();
  console.log('Browser smoke: Pass & Play and five-round Local Party sessions passed');
})().catch(error => { console.error(error); process.exit(1); });
