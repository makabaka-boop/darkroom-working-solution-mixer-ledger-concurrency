/**
 * 容量台账的 localStorage 持久化。
 *
 * 批次与使用记录整体存为一个 JSON 文档；读取时逐字段校验结构，
 * 损坏或版本不符的数据一律视为空台账，绝不让异常进入界面。
 * 使用记录只追加不修改，因此这里也只提供整体读 / 写，不提供单条更新。
 *
 * 批次的配液来源快照（mixSource）是可选字段：旧数据没有它，照常读取；
 * 一旦出现就必须通过结构校验，否则整份数据视为不可信。
 */

import {
  EMPTY_LEDGER,
  isMixSourceSnapshot,
  type ChemicalBatch,
  type LedgerState,
  type UsageRecord,
} from './capacityLedger';

export const LEDGER_STORAGE_KEY = 'darkroom.capacity-ledger.v1';

/** 与 Web Storage 对齐的最小接口，便于在 Node 测试中注入内存实现。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isPositiveInteger(value: unknown): value is number {
  // 必须是安全整数：非安全整数（如 Infinity、超长数字解析值、2^53 以上的舍入值）
  // 无法精确往返，JSON 序列化后可能变成 null，会污染整份台账。
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseBatch(value: unknown): ChemicalBatch | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !isNonEmptyString(candidate.id) ||
    !isNonEmptyString(candidate.name) ||
    !isPositiveInteger(candidate.capacity) ||
    typeof candidate.createdAt !== 'string'
  ) {
    return null;
  }
  const batch: ChemicalBatch = {
    id: candidate.id,
    name: candidate.name,
    capacity: candidate.capacity,
    createdAt: candidate.createdAt,
  };
  // 配液来源快照为可选字段：旧数据没有它，照常接受；
  // 一旦出现就必须结构完整，否则整份数据不可信。
  if (candidate.mixSource !== undefined) {
    if (!isMixSourceSnapshot(candidate.mixSource)) return null;
    const snapshot = candidate.mixSource;
    batch.mixSource = {
      n: snapshot.n,
      total: snapshot.total,
      capacity: snapshot.capacity,
      tanks: snapshot.tanks,
      concentrate: snapshot.concentrate,
      water: snapshot.water,
    };
  }
  return batch;
}

function parseRecord(value: unknown): UsageRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !isNonEmptyString(candidate.id) ||
    !isNonEmptyString(candidate.batchId) ||
    !isPositiveInteger(candidate.films) ||
    typeof candidate.note !== 'string' ||
    !isNonNegativeInteger(candidate.remainingAfter) ||
    typeof candidate.createdAt !== 'string'
  ) {
    return null;
  }
  return {
    id: candidate.id,
    batchId: candidate.batchId,
    films: candidate.films,
    note: candidate.note,
    remainingAfter: candidate.remainingAfter,
    createdAt: candidate.createdAt,
  };
}

/** 反序列化：任一环节失败（JSON 损坏、结构不符）都返回 null。 */
export function parseLedger(json: string): LedgerState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (!Array.isArray(candidate.batches) || !Array.isArray(candidate.records)) return null;

  const batches: ChemicalBatch[] = [];
  for (const item of candidate.batches) {
    const batch = parseBatch(item);
    if (!batch) return null;
    batches.push(batch);
  }
  const batchIds = new Set(batches.map((batch) => batch.id));

  const records: UsageRecord[] = [];
  for (const item of candidate.records) {
    const record = parseRecord(item);
    // 记录必须挂在已知批次上，否则整份数据不可信
    if (!record || !batchIds.has(record.batchId)) return null;
    records.push(record);
  }
  return { batches, records };
}

export function serializeLedger(state: LedgerState): string {
  return JSON.stringify(state);
}

/** 从存储还原台账；无数据或数据损坏时返回空台账。 */
export function loadLedger(storage: StorageLike | undefined): LedgerState {
  if (!storage) return EMPTY_LEDGER;
  const json = storage.getItem(LEDGER_STORAGE_KEY);
  if (json === null) return EMPTY_LEDGER;
  return parseLedger(json) ?? EMPTY_LEDGER;
}

/**
 * 整体写入台账（调用方保证传入的是命令产出的新状态）。
 * 写入前做一次「序列化 → 反序列化」往返校验：
 * 若产出的状态无法被本模块原样读回（含 Infinity / null 等无法精确表示的值），
 * 则拒绝写入并保留存储中的旧台账，避免一次异常写入让刷新后整份台账消失。
 */
export function saveLedger(storage: StorageLike | undefined, state: LedgerState): void {
  if (!storage) return;
  const json = serializeLedger(state);
  if (parseLedger(json) === null) return;
  storage.setItem(LEDGER_STORAGE_KEY, json);
}

/** 浏览器环境下的默认存储；SSR / 测试环境下为 undefined。 */
export function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
