import { describe, expect, it } from 'vitest';
import {
  createBatch,
  EMPTY_LEDGER,
  recordUsage,
  usedCapacity,
  type LedgerDeps,
  type LedgerState,
} from '../../src/lib/capacityLedger';
import {
  COMMIT_CONFLICT_MESSAGE,
  COMMIT_UNAVAILABLE_MESSAGE,
  commitFailureMessage,
  commitLedger,
  LEDGER_STORAGE_KEY,
  loadLedger,
  saveLedger,
  serializeLedger,
  type CommitResult,
  type StorageLike,
} from '../../src/lib/ledgerStorage';

function testDeps(): LedgerDeps {
  let counter = 0;
  return {
    now: () => {
      counter += 1;
      return new Date(Date.UTC(2026, 8, 23, 12, 0, 0) + counter * 1000);
    },
    nextId: () => `test-id-${counter}`,
  };
}

type MemoryStore = StorageLike & {
  dump: () => Map<string, string>;
  failNextWrites: (times: number) => void;
  failAllWrites: () => void;
};

function memoryStorage(): MemoryStore {
  const data = new Map<string, string>();
  let writesToFail = 0;
  let failAll = false;
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (failAll || writesToFail > 0) {
        writesToFail = Math.max(0, writesToFail - 1);
        // 模拟 QuotaExceededError / SecurityError
        throw new DOMException('配额不足或被安全策略拒绝', 'QuotaExceededError');
      }
      data.set(key, value);
    },
    dump: () => data,
    failNextWrites: (times) => {
      writesToFail = times;
    },
    failAllWrites: () => {
      failAll = true;
    },
  };
}

function mustCreate(state: LedgerState, name: string, capacity: string, deps: LedgerDeps) {
  const result = createBatch(state, { name, capacity }, deps);
  if (!result.ok) throw new Error(`前置创建失败：${result.error}`);
  return result;
}

function mustRecord(state: LedgerState, batchId: string, films: string, deps: LedgerDeps) {
  const result = recordUsage(state, { batchId, films }, deps);
  if (!result.ok) throw new Error(`前置登记失败：${result.error}`);
  return result;
}

/** 搭好一份「容量 10 的显影液、已登记 4（版本 1）」的已落盘台账。 */
function seedLedger(storage: MemoryStore): { state: LedgerState; batchId: string; deps: LedgerDeps } {
  const deps = testDeps();
  const created = mustCreate(EMPTY_LEDGER, 'D-76 显影液', '10', deps);
  const recorded = mustRecord(created.state, created.value.id, '4', deps);
  saveLedger(storage, recorded.state);
  // saveLedger 不带版本语义（测试辅助），手动置为版本 1，模拟一次真实提交后的文档
  const v1 = { ...recorded.state, version: 1 };
  storage.dump().set(LEDGER_STORAGE_KEY, serializeLedger(v1));
  return { state: v1, batchId: created.value.id, deps };
}

describe('commitLedger 乐观并发提交', () => {
  it('版本匹配时提交成功：版本恰好 +1，记录可重新读回', () => {
    const storage = memoryStorage();
    const { state, batchId, deps } = seedLedger(storage);

    const next = mustRecord(state, batchId, '3', deps).state;
    const result = commitLedger(storage, state.version, next);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.version).toBe(2);

    const restored = loadLedger(storage);
    expect(restored).toEqual(result.state);
    expect(usedCapacity(restored, batchId)).toBe(7);
    expect(restored.records.map((r) => r.films)).toEqual([4, 3]);
  });

  it('两个页面从同一旧状态分别提交：后提交者被 conflict 拒绝，先提交记录保留且容量不为负', () => {
    const storage = memoryStorage();
    const { state, batchId, deps } = seedLedger(storage);

    // 页面 A 与页面 B 同时持有版本 1（剩余 6）
    const pageANext = mustRecord(state, batchId, '4', deps).state; // A 登记 4
    const pageBNext = mustRecord(state, batchId, '5', deps).state; // B 登记 5（基于旧剩余 6，单看合法）

    // A 先提交成功
    const a = commitLedger(storage, 1, pageANext);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.state.version).toBe(2);

    // B 后提交：版本仍是 1 → 冲突拒绝，B 的记录绝不落盘，也不会让累计超过 10
    const b = commitLedger(storage, 1, pageBNext);
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.reason).toBe('conflict');
    expect(b.stored.version).toBe(2);
    expect(b.stored.records.map((r) => r.films)).toEqual([4, 4]);
    expect(usedCapacity(b.stored, batchId)).toBe(8);

    const restored = loadLedger(storage);
    expect(restored.records).toHaveLength(2);
    expect(restored.records.map((r) => r.films)).toEqual([4, 4]);
    expect(usedCapacity(restored, batchId)).toBe(8); // 10 − 8 = 2，绝不为负
  });

  it('冲突后被拒页面基于最新台账重提：成功且记录顺序为全提交序，版本连续递增', () => {
    const storage = memoryStorage();
    const { state, batchId, deps } = seedLedger(storage);

    // A 先登记 4（4+4=8，剩 2）
    const a = commitLedger(storage, 1, mustRecord(state, batchId, '4', deps).state);
    expect(a.ok).toBe(true);

    // B 基于旧状态登记 5 被拒，得到最新状态（剩 2）
    const rejected = commitLedger(storage, 1, mustRecord(state, batchId, '5', deps).state);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;

    // B 核对最新剩余 2 后改登记 2，在最新版本上重新提交成功
    const fresh = rejected.stored;
    const retried = mustRecord(fresh, batchId, '2', deps).state;
    const b = commitLedger(storage, fresh.version, retried);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.state.version).toBe(3);
    expect(b.state.records.map((r) => r.films)).toEqual([4, 4, 2]);
    expect(usedCapacity(b.state, batchId)).toBe(10);
  });

  it('不同批次交错提交互不丢记录：B 页的新批次不会被旧页面回滚', () => {
    const storage = memoryStorage();
    const { state, batchId, deps } = seedLedger(storage);

    // 旧页面 P1 停在版本 1，准备向已有批次登记 3
    const p1Next = mustRecord(state, batchId, '3', deps).state;

    // 另一页面 P2 在版本 1 上先创建「定影液」批次（版本推进到 2）
    const p2Create = mustCreate(state, '定影液', '5', deps);
    const c1 = commitLedger(storage, 1, p2Create.state);
    expect(c1.ok).toBe(true);
    // P2 继续向新批次登记 2（版本推进到 3）
    if (!c1.ok) return;
    const p2Record = mustRecord(c1.state, p2Create.value.id, '2', deps).state;
    const c2 = commitLedger(storage, c1.state.version, p2Record);
    expect(c2.ok).toBe(true);
    if (!c2.ok) return;
    expect(c2.state.batches.map((b) => b.name)).toEqual(['D-76 显影液', '定影液']);

    // P1 此时才提交旧改动：冲突拒绝，P2 的批次与记录完整保留
    const stale = commitLedger(storage, 1, p1Next);
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.reason).toBe('conflict');
    expect(stale.stored.batches).toHaveLength(2);
    expect(stale.stored.records.map((r) => `${r.batchId === p2Create.value.id ? 'F' : 'D'}:${r.films}`)).toEqual([
      'D:4',
      'F:2',
    ]);

    // P1 同步到版本 3 后重新提交自己的登记 3：两个批次的记录都在
    const merged = mustRecord(stale.stored, batchId, '3', deps).state;
    const retry = commitLedger(storage, stale.stored.version, merged);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.state.batches).toHaveLength(2);
    expect(retry.state.records).toHaveLength(3);
    expect(usedCapacity(retry.state, batchId)).toBe(7);
    expect(usedCapacity(retry.state, p2Create.value.id)).toBe(2);
  });

  it('setItem 抛错（配额 / 安全策略）时拒绝动作并保留最后完整台账，重试可成功', () => {
    const storage = memoryStorage();
    const { state, batchId, deps } = seedLedger(storage);
    const jsonBefore = storage.dump().get(LEDGER_STORAGE_KEY);

    storage.failNextWrites(1);
    const next = mustRecord(state, batchId, '3', deps).state;
    const failed: CommitResult = commitLedger(storage, state.version, next);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.reason).toBe('unavailable');
    // 存储中的旧文档原样保留
    expect(storage.dump().get(LEDGER_STORAGE_KEY)).toBe(jsonBefore);
    expect(loadLedger(storage)).toEqual(state);
    expect(commitFailureMessage(failed.reason)).toBe(COMMIT_UNAVAILABLE_MESSAGE);

    // 存储恢复后用同一版本重试：成功，版本与记录正常推进
    const retried = commitLedger(storage, state.version, next);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.state.version).toBe(2);
    expect(loadLedger(storage).records).toHaveLength(2);
  });

  it('存储持续不可用时每次提交都失败，绝不产生部分写入或版本跳变', () => {
    const storage = memoryStorage();
    const { state, batchId, deps } = seedLedger(storage);
    storage.failAllWrites();

    for (const films of ['1', '2', '3']) {
      const result = commitLedger(storage, state.version, mustRecord(state, batchId, films, deps).state);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unavailable');
    }
    const restored = loadLedger(storage);
    expect(restored.version).toBe(1);
    expect(restored.records).toHaveLength(1);
  });

  it('存储被外部清空（版本归零）后旧页面提交被判为冲突，不会覆盖成自己的旧台账', () => {
    const storage = memoryStorage();
    const { state, batchId, deps } = seedLedger(storage);

    storage.dump().delete(LEDGER_STORAGE_KEY); // 外部（或用户）清空
    const next = mustRecord(state, batchId, '1', deps).state;
    const result = commitLedger(storage, state.version, next);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('conflict');
    expect(result.stored).toEqual(EMPTY_LEDGER);
    // 没有任何写入
    expect(storage.getItem(LEDGER_STORAGE_KEY)).toBeNull();
  });

  it('旧版文档（无 version 字段）按版本 0 读取，首次提交成功后升级为版本 1', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '旧版批次', '6', deps);
    // 手工写出没有 version 字段的旧版文档
    const legacyJson = JSON.stringify({ batches: created.state.batches, records: [] });
    storage.dump().set(LEDGER_STORAGE_KEY, legacyJson);

    const restored = loadLedger(storage);
    expect(restored.version).toBe(0);
    expect(restored.batches[0].name).toBe('旧版批次');

    const next = mustRecord(restored, created.value.id, '2', deps).state;
    const result = commitLedger(storage, 0, next);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.version).toBe(1);
    const reloaded = loadLedger(storage);
    expect(reloaded.version).toBe(1);
    expect(reloaded.records.map((r) => r.films)).toEqual([2]);
  });

  it('conflict 提示文案固定为跨标签页更新说明', () => {
    expect(commitFailureMessage('conflict')).toBe(COMMIT_CONFLICT_MESSAGE);
  });
});
