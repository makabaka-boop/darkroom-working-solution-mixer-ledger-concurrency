import { expect, test, type Page } from '@playwright/test';
import { LEDGER_STORAGE_KEY } from '../../src/lib/ledgerStorage';

/**
 * 容量台账跨标签页并发验收。
 *
 * 场景构造：两个浏览器标签页（同一 context，共享 localStorage）先读取同一份旧台账，
 * 再交错提交。真实环境下页面会经 storage 事件实时同步外部写入；为确定性复现
 * 「操作员停留在旧页面、按过期剩余量提交」的竞态，测试用 init script 安装一个
 * 捕获阶段的 storage 事件阻断开关（__blockLedgerStorageEvents），
 * 关闭该开关后事件照常到达，等价于旧页面重新激活 / 刷新后的同步。
 *
 * 覆盖：同批次并发、不同批次交错、外部新建批次、写入失败（配额 / 安全策略）；
 * 每步都逐次刷新并核对记录集合、累计量、状态、错误提示以及 localStorage 原始内容。
 */

const ISO = '2026-09-23T00:00:00.000Z';

/** 旧台账：D-76 容量 10、已登记 4（剩 6）；定影液容量 5、已登记 2（剩 3），版本 1。 */
function seedDocument(): string {
  return JSON.stringify({
    version: 1,
    batches: [
      { id: 'b-dev', name: 'D-76 显影液', capacity: 10, createdAt: ISO },
      { id: 'b-fix', name: '定影液', capacity: 5, createdAt: ISO },
    ],
    records: [
      { id: 'r-dev-1', batchId: 'b-dev', films: 4, note: '初始记录', remainingAfter: 6, createdAt: ISO },
      { id: 'r-fix-1', batchId: 'b-fix', films: 2, note: '', remainingAfter: 3, createdAt: ISO },
    ],
  });
}

async function seedLedger(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate((documentJson) => {
    window.localStorage.setItem('darkroom.capacity-ledger.v1', documentJson);
  }, seedDocument());
}

/** 读取 localStorage 中的原始台账文档。 */
async function readRawLedger(page: Page) {
  const json = await page.evaluate((key) => window.localStorage.getItem(key), LEDGER_STORAGE_KEY);
  expect(json).not.toBeNull();
  return JSON.parse(json!) as {
    version: number;
    batches: Array<{ id: string; name: string; capacity: number }>;
    records: Array<{ id: string; batchId: string; films: number; note: string; remainingAfter: number }>;
  };
}

async function gotoLedger(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('nav-ledger').click();
  await expect(page.getByTestId('batch-item')).toHaveCount(2);
}

function batchRow(page: Page, name: string) {
  return page.getByTestId('batch-item').filter({ hasText: name });
}

async function selectBatch(page: Page, name: string): Promise<void> {
  await batchRow(page, name).click();
  await expect(page.getByTestId('usage-panel')).toContainText(name);
}

test.describe('容量台账跨标签页并发', () => {
  test.beforeEach(async ({ context }) => {
    // 模拟「操作员停留在旧页面、不感知外部写入」：可开关地吞掉发往 window 的台账
    // storage 事件。init script 先于任何页面脚本执行，阻断监听器注册在最前；
    // 捕获与冒泡两个阶段都 stopImmediatePropagation，页面在 window 上的监听器
    // （React 效果绑定在冒泡阶段）均收不到事件。关闭开关后事件照常到达。
    await context.addInitScript(() => {
      const w = window as unknown as {
        __blockLedgerStorageEvents?: boolean;
        addEventListener: Window['addEventListener'];
      };
      w.__blockLedgerStorageEvents = false;
      const blocker = (event: Event) => {
        if (w.__blockLedgerStorageEvents && (event as StorageEvent).key === 'darkroom.capacity-ledger.v1') {
          event.stopImmediatePropagation();
        }
      };
      w.addEventListener('storage', blocker, true);
      w.addEventListener('storage', blocker, false);
    });
  });

  test('同批次：两页从相同剩余量交错提交，仅先到者落盘，被拒页刷新前后都不扣减、无成功假象', async ({
    context,
  }) => {
    // 两页读取同一旧状态（版本 1，D-76 剩 6），并冻结它们对外部写入的感知
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await seedLedger(pageA);
    await gotoLedger(pageA);
    await gotoLedger(pageB);
    await pageA.evaluate(() => {
      (window as unknown as { __blockLedgerStorageEvents: boolean }).__blockLedgerStorageEvents = true;
    });
    await pageB.evaluate(() => {
      (window as unknown as { __blockLedgerStorageEvents: boolean }).__blockLedgerStorageEvents = true;
    });
    await selectBatch(pageA, 'D-76 显影液');
    await selectBatch(pageB, 'D-76 显影液');
    await expect(pageA.getByTestId('detail-remaining')).toHaveText('6');
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('6');

    // 两页都按过期的剩余 6 填写各自合法的用量
    await pageA.getByTestId('films-input').fill('4');
    await pageB.getByTestId('films-input').fill('5');
    await pageA.getByTestId('note-input').fill('A 页登记');

    // A 先提交：成功，剩 2
    await pageA.getByTestId('record-usage-button').click();
    await expect(pageA.getByTestId('ledger-write-error')).toHaveCount(0);
    await expect(pageA.getByTestId('usage-item')).toHaveCount(2);
    await expect(pageA.getByTestId('detail-used')).toHaveText('8');
    await expect(pageA.getByTestId('detail-remaining')).toHaveText('2');
    const rawAfterA = await readRawLedger(pageA);
    expect(rawAfterA.version).toBe(2);
    expect(rawAfterA.records.map((r) => r.films)).toEqual([4, 2, 4]);
    expect(rawAfterA.records.at(-1)!.remainingAfter).toBe(2);

    // B 随后提交：本地看似合法（5 ≤ 6），但存储版本已到 2 → 拒绝当前动作
    await pageB.getByTestId('record-usage-button').click();
    await expect(pageB.getByTestId('ledger-write-error')).toBeVisible();
    await expect(pageB.getByTestId('ledger-write-error')).toContainText('台账已被其他标签页更新');
    // B 没有产生「登记成功」：自己的 5 未落盘；页面同步为 A 写入后的最新台账
    // （A 的两条记录、累计 8、剩余 2），输入草稿保留以便核对后按新余量重提
    await expect(pageB.getByTestId('usage-item')).toHaveCount(2);
    await expect(pageB.getByTestId('usage-films')).toHaveText(['4', '4']);
    await expect(pageB.getByTestId('detail-used')).toHaveText('8');
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('2');
    await expect(pageB.getByTestId('films-input')).toHaveValue('5');

    // 存储原始内容：仍是 A 提交后的文档，B 的记录不存在，版本未再推进
    const rawAfterB = await readRawLedger(pageB);
    expect(rawAfterB).toEqual(rawAfterA);
    expect(rawAfterB.records).toHaveLength(3);
    expect(rawAfterB.records.some((r) => r.films === 5)).toBe(false);

    // 解除阻断：即使不刷新，B 页也经 storage 重放后的最新状态一致（此处通过刷新严格核对）
    await pageB.evaluate(() => {
      (window as unknown as { __blockLedgerStorageEvents: boolean }).__blockLedgerStorageEvents = false;
    });
    await pageB.reload();
    await pageB.getByTestId('nav-ledger').click();
    const rowB = batchRow(pageB, 'D-76 显影液');
    await expect(rowB.getByTestId('batch-used')).toHaveText('8');
    await expect(rowB.getByTestId('batch-remaining')).toHaveText('2');
    await expect(rowB.getByTestId('batch-status')).toHaveText('使用中');
    await selectBatch(pageB, 'D-76 显影液');
    await expect(pageB.getByTestId('usage-item')).toHaveCount(2);
    await expect(pageB.getByTestId('usage-films').nth(1)).toHaveText('4');

    // B 按最新剩余 2 重新登记：成功，恰好耗尽，两页刷新后完全一致
    await pageB.getByTestId('films-input').fill('2');
    await pageB.getByTestId('record-usage-button').click();
    await expect(pageB.getByTestId('ledger-write-error')).toHaveCount(0);
    await expect(pageB.getByTestId('detail-status')).toHaveText('已耗尽');
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('0');

    const rawFinal = await readRawLedger(pageA);
    expect(rawFinal.version).toBe(3);
    expect(rawFinal.records.map((r) => r.films)).toEqual([4, 2, 4, 2]);
    expect(rawFinal.records.at(-1)!.remainingAfter).toBe(0);

    // 两页逐次刷新：同一批次集合、同一记录顺序、同一累计 / 剩余 / 状态
    for (const page of [pageA, pageB]) {
      await page.reload();
      await page.getByTestId('nav-ledger').click();
      const dev = batchRow(page, 'D-76 显影液');
      const fix = batchRow(page, '定影液');
      await expect(dev.getByTestId('batch-status')).toHaveText('已耗尽');
      await expect(dev.getByTestId('batch-used')).toHaveText('10');
      await expect(dev.getByTestId('batch-remaining')).toHaveText('0');
      await expect(fix.getByTestId('batch-used')).toHaveText('2');
      await expect(fix.getByTestId('batch-remaining')).toHaveText('3');
      await selectBatch(page, 'D-76 显影液');
      await expect(page.getByTestId('usage-films')).toHaveText(['4', '4', '2']);
      await expect(page.getByTestId('usage-remaining').nth(2)).toHaveText('0');
      // 已耗尽后再登记仍被拒绝（以最新台账为准）
      await page.getByTestId('films-input').fill('1');
      await page.getByTestId('record-usage-button').click();
      await expect(page.getByTestId('error-films')).toContainText('超过剩余容量：本批仅剩 0');
    }
  });

  test('不同批次 + 外部新建批次：旧页面迟交不回滚他人批次与记录，同步后合并共存', async ({
    context,
  }) => {
    const pageOld = await context.newPage();
    const pageNew = await context.newPage();
    await seedLedger(pageOld);
    await gotoLedger(pageOld);
    await gotoLedger(pageNew);
    // 旧页面停留在版本 1，不再接收外部写入
    await pageOld.evaluate(() => {
      (window as unknown as { __blockLedgerStorageEvents: boolean }).__blockLedgerStorageEvents = true;
    });

    // 旧页面准备给定影液登记 3（基于旧剩余 3，恰好耗尽）
    await selectBatch(pageOld, '定影液');
    await expect(pageOld.getByTestId('detail-remaining')).toHaveText('3');
    await pageOld.getByTestId('films-input').fill('3');
    await pageOld.getByTestId('note-input').fill('旧页面迟交');

    // 新页面：向 D-76 登记 2（版本 1 → 2）
    await selectBatch(pageNew, 'D-76 显影液');
    await pageNew.getByTestId('films-input').fill('2');
    await pageNew.getByTestId('record-usage-button').click();
    await expect(pageNew.getByTestId('detail-remaining')).toHaveText('4');

    // 新页面再新建一个批次「停显液」容量 7（版本 2 → 3）
    await pageNew.getByTestId('batch-name-input').fill('停显液');
    await pageNew.getByTestId('batch-capacity-input').fill('7');
    await pageNew.getByTestId('create-batch-button').click();
    await expect(pageNew.getByTestId('batch-item')).toHaveCount(3);
    await expect(pageNew.getByTestId('batch-name').last()).toHaveText('停显液');

    const rawBeforeOldSubmit = await readRawLedger(pageNew);
    expect(rawBeforeOldSubmit.version).toBe(3);
    expect(rawBeforeOldSubmit.batches.map((b) => b.name)).toEqual(['D-76 显影液', '定影液', '停显液']);

    // 旧页面此时才提交：冲突拒绝，横幅说明；新页面刚建的批次与记录不得被回滚
    await pageOld.getByTestId('record-usage-button').click();
    await expect(pageOld.getByTestId('ledger-write-error')).toContainText('台账已被其他标签页更新');
    await expect(pageOld.getByTestId('usage-item')).toHaveCount(1);
    await expect(pageOld.getByTestId('detail-remaining')).toHaveText('3');

    // 旧页面已同步到存储中的完整台账：停显液出现、D-76 累计含新页面的 2
    await expect(pageOld.getByTestId('batch-item')).toHaveCount(3);
    const oldDev = batchRow(pageOld, 'D-76 显影液');
    await expect(oldDev.getByTestId('batch-used')).toHaveText('6');
    await expect(oldDev.getByTestId('batch-remaining')).toHaveText('4');
    await expect(batchRow(pageOld, '停显液')).toBeVisible();

    // 存储原始内容未被旧页面覆盖
    expect(await readRawLedger(pageOld)).toEqual(rawBeforeOldSubmit);

    // 旧页面刷新后保持同一台账，再把定影液的 3 在最新版本上提交成功
    await pageOld.evaluate(() => {
      (window as unknown as { __blockLedgerStorageEvents: boolean }).__blockLedgerStorageEvents = false;
    });
    await pageOld.reload();
    await pageOld.getByTestId('nav-ledger').click();
    await expect(pageOld.getByTestId('batch-item')).toHaveCount(3);
    await selectBatch(pageOld, '定影液');
    await expect(pageOld.getByTestId('detail-remaining')).toHaveText('3');
    await pageOld.getByTestId('films-input').fill('3');
    await pageOld.getByTestId('record-usage-button').click();
    await expect(pageOld.getByTestId('detail-status')).toHaveText('已耗尽');

    const rawMerged = await readRawLedger(pageOld);
    expect(rawMerged.version).toBe(4);
    expect(rawMerged.batches.map((b) => b.name)).toEqual(['D-76 显影液', '定影液', '停显液']);
    // 全局记录顺序即提交顺序：初始 D、初始 F、新页 D(2)、旧页 F(3)
    expect(rawMerged.records.map((r) => `${r.batchId}:${r.films}`)).toEqual([
      'b-dev:4',
      'b-fix:2',
      'b-dev:2',
      'b-fix:3',
    ]);

    // 两页刷新后完全一致
    for (const page of [pageOld, pageNew]) {
      await page.reload();
      await page.getByTestId('nav-ledger').click();
      await expect(page.getByTestId('batch-item')).toHaveCount(3);
      await expect(batchRow(page, 'D-76 显影液').getByTestId('batch-used')).toHaveText('6');
      await expect(batchRow(page, '定影液').getByTestId('batch-status')).toHaveText('已耗尽');
      await expect(batchRow(page, '停显液').getByTestId('batch-remaining')).toHaveText('7');
    }
  });

  test('写入失败（配额 / 安全策略拒绝 setItem）：不显示成功、不扣减，刷新后仍是旧台账，恢复后可重新记账', async ({
    context,
  }) => {
    const page = await context.newPage();
    await seedLedger(page);
    await gotoLedger(page);
    await selectBatch(page, 'D-76 显影液');

    const rawBefore = await readRawLedger(page);

    // 让本页的 localStorage.setItem 一律抛错（模拟配额已满 / 安全策略拒绝）
    await page.evaluate(() => {
      const original = window.localStorage.setItem.bind(window.localStorage);
      (window as unknown as { __originalSetItem?: Storage['setItem'] }).__originalSetItem = original;
      window.localStorage.setItem = () => {
        throw new DOMException('配额已满', 'QuotaExceededError');
      };
    });

    // 容量本身合法（3 ≤ 6），但落盘失败：只能拒绝当前动作
    await page.getByTestId('films-input').fill('3');
    await page.getByTestId('note-input').fill('存储失败的一次');
    await page.getByTestId('record-usage-button').click();
    await expect(page.getByTestId('ledger-write-error')).toBeVisible();
    await expect(page.getByTestId('ledger-write-error')).toContainText('台账保存失败');
    // 界面绝不保留「登记成功」与已扣减余量
    await expect(page.getByTestId('usage-item')).toHaveCount(1);
    await expect(page.getByTestId('detail-used')).toHaveText('4');
    await expect(page.getByTestId('detail-remaining')).toHaveText('6');
    await expect(page.getByTestId('films-input')).toHaveValue('3');
    // 失败那次的备注绝不出现（种子记录备注为「初始记录」，仍应恰好 1 条）
    await expect(page.getByTestId('usage-item')).toHaveCount(1);
    await expect(page.getByTestId('usage-note')).toHaveText(/初始记录/);

    // 存储原始文档原样保留（版本仍为 1，失败记录不在其中）
    expect(await readRawLedger(page)).toEqual(rawBefore);

    // 另一页面正常写入（不受本页 setItem 劫持影响）仍可成功，证明存储未被破坏
    const other = await context.newPage();
    await gotoLedger(other);
    await selectBatch(other, '定影液');
    await other.getByTestId('films-input').fill('1');
    await other.getByTestId('record-usage-button').click();
    await expect(other.getByTestId('ledger-write-error')).toHaveCount(0);
    await expect(other.getByTestId('detail-remaining')).toHaveText('2');

    // 本页恢复 setItem 后刷新：显示其他页面的写入，自己的失败记录不存在
    await page.evaluate(() => {
      const holder = window as unknown as { __originalSetItem?: Storage['setItem'] };
      if (holder.__originalSetItem) window.localStorage.setItem = holder.__originalSetItem;
    });
    await page.reload();
    await page.getByTestId('nav-ledger').click();
    await expect(page.getByTestId('batch-item')).toHaveCount(2);
    await expect(batchRow(page, 'D-76 显影液').getByTestId('batch-used')).toHaveText('4');
    await expect(batchRow(page, 'D-76 显影液').getByTestId('batch-remaining')).toHaveText('6');
    await expect(batchRow(page, '定影液').getByTestId('batch-used')).toHaveText('3');
    await selectBatch(page, 'D-76 显影液');
    await expect(page.getByTestId('usage-item')).toHaveCount(1);
    await expect(page.getByTestId('usage-films')).toHaveText('4');

    // 恢复后重新登记同用量：成功且刷新后保留，可追溯
    await page.getByTestId('films-input').fill('3');
    await page.getByTestId('record-usage-button').click();
    await expect(page.getByTestId('ledger-write-error')).toHaveCount(0);
    await expect(page.getByTestId('detail-used')).toHaveText('7');
    await expect(page.getByTestId('detail-remaining')).toHaveText('3');
    await page.reload();
    await page.getByTestId('nav-ledger').click();
    await selectBatch(page, 'D-76 显影液');
    await expect(page.getByTestId('usage-item')).toHaveCount(2);
    await expect(page.getByTestId('usage-films').nth(1)).toHaveText('3');
    const raw = await readRawLedger(page);
    expect(raw.records.some((r) => r.note === '存储失败的一次')).toBe(false);
  });

  test('实时同步：不刷新页面，外部写入后当前页批次状态与剩余量立即更新，按新余量提交成功', async ({
    context,
  }) => {
    const page = await context.newPage();
    const other = await context.newPage();
    await seedLedger(page);
    await gotoLedger(page);
    await gotoLedger(other);
    await selectBatch(page, 'D-76 显影液');
    await expect(page.getByTestId('detail-remaining')).toHaveText('6');

    // 另一页（不阻断 storage 事件）登记 5：当前页无需刷新即同步
    await selectBatch(other, 'D-76 显影液');
    await other.getByTestId('films-input').fill('5');
    await other.getByTestId('record-usage-button').click();
    await expect(other.getByTestId('detail-remaining')).toHaveText('1');

    await expect(page.getByTestId('detail-remaining')).toHaveText('1');
    await expect(page.getByTestId('detail-used')).toHaveText('9');
    await expect(page.getByTestId('usage-item')).toHaveCount(2);
    await expect(page.getByTestId('usage-films').nth(1)).toHaveText('5');

    // 当前页若仍按旧余量填 3，提交会被命令按最新状态拒绝（超量），不写入
    await page.getByTestId('films-input').fill('3');
    await page.getByTestId('record-usage-button').click();
    await expect(page.getByTestId('error-films')).toContainText('超过剩余容量：本批仅剩 1');
    await expect(page.getByTestId('usage-item')).toHaveCount(2);

    // 改为 1：恰好耗尽
    await page.getByTestId('films-input').fill('1');
    await page.getByTestId('record-usage-button').click();
    await expect(page.getByTestId('detail-status')).toHaveText('已耗尽');
    await expect(batchRow(other, 'D-76 显影液').getByTestId('batch-status')).toHaveText('已耗尽');
    const raw = await readRawLedger(page);
    expect(raw.records.map((r) => r.films)).toEqual([4, 2, 5, 1]);
  });
});
