/**
 * 容量台账的 localStorage 持久化（含跨标签页乐观并发控制）。
 *
 * 批次与使用记录整体存为一个带版本号的 JSON 文档；读取时逐字段校验结构，
 * 损坏或版本不符的数据一律视为「版本 0 的空台账」，绝不让异常进入界面。
 * 使用记录只追加不修改，因此这里也只提供整体读 / 提交，不提供单条更新。
 *
 * 跨标签页协议（乐观并发，读—改—提交必须原子）：
 * 1. 页面先 loadLedger 得到状态及其版本 version；
 * 2. 在该状态上用领域命令（createBatch / recordUsage）产出新状态；
 * 3. commitLedger 提交时重新读取存储中的当前文档：
 *    - 存储版本与本页依据的 expectedVersion 一致时，才允许写入，
 *      并把版本 +1（每次成功提交恰好 +1）；
 *    - 不一致说明其他标签页已经写入：本次动作整体拒绝（conflict），
 *      返回存储中的最新完整台账，由界面同步展示，绝不覆盖对方的写入。
 * 4. setItem 抛错（配额不足 / 安全策略拒绝）或新文档无法通过
 *    序列化往返校验时同样拒绝（unavailable / rejected），
 *      存储中的旧文档原样保留——「只拒绝当前动作，保留最后完整台账」。
 *
 * 界面另通过 window 的 storage 事件在提交之外实时同步外部写入，
 * 因此所有打开的页面最终显示同一批次集合、记录顺序与剩余容量。
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

/** 版本字段：非负安全整数；缺失（旧版台账）按 0 处理。 */
function normalizeVersion(value: unknown): number {
  return isNonNegativeInteger(value) ? value : 0;
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

/** 反序列化：任一环节失败（JSON 损坏、结构不符）都返回 null（版本字段不参与旧判断）。 */
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
  return { batches, records, version: normalizeVersion(candidate.version) };
}

/**
 * 序列化台账文档。状态内版本字段可能缺失（命令产出的纯状态不带版本语义变化），
 * 统一由提交方在落盘时写入正确版本；这里仅做防御性回退（缺失按 0）。
 */
export function serializeLedger(state: LedgerState): string {
  return JSON.stringify({ ...state, version: normalizeVersion(state.version) });
}

/** 从存储还原台账；无数据或数据损坏时返回版本 0 的空台账。 */
export function loadLedger(storage: StorageLike | undefined): LedgerState {
  if (!storage) return EMPTY_LEDGER;
  let json: string | null;
  try {
    json = storage.getItem(LEDGER_STORAGE_KEY);
  } catch {
    // 安全策略连读取都拒绝：视为不可用的空台账，后续提交会再报 unavailable
    return EMPTY_LEDGER;
  }
  if (json === null) return EMPTY_LEDGER;
  return parseLedger(json) ?? EMPTY_LEDGER;
}

/**
 * 整体写入台账（不做版本检查），保留给「无并发语境」的调用与测试。
 * 写入前做一次「序列化 → 反序列化」往返校验：
 * 若产出的状态无法被本模块原样读回（含 Infinity / null 等无法精确表示的值），
 * 则拒绝写入并保留存储中的旧台账，避免一次异常写入让刷新后整份台账消失。
 * setItem 自身抛错（配额 / 安全策略）向上传播，由调用方按存储失败处理。
 */
export function saveLedger(storage: StorageLike | undefined, state: LedgerState): void {
  if (!storage) return;
  const json = serializeLedger(state);
  if (parseLedger(json) === null) return;
  storage.setItem(LEDGER_STORAGE_KEY, json);
}

/** 提交失败原因分类（界面据此给出不同中文提示）。 */
export type CommitFailureReason =
  | 'conflict'
  | 'unavailable'
  | 'rejected';

export type CommitResult =
  | { ok: true; state: LedgerState }
  | {
      ok: false;
      reason: CommitFailureReason;
      /** 失败时存储中仍然完整的最新台账（界面应同步到它） */
      stored: LedgerState;
    };

/** 冲突提示：其他标签页已先写入，本页依据的是旧台账。 */
export const COMMIT_CONFLICT_MESSAGE =
  '台账已被其他标签页更新，本次登记未写入，请核对最新批次与剩余容量后重新登记';

/** 存储失败提示：配额 / 安全策略拒绝写入，存储内容保持不变。 */
export const COMMIT_UNAVAILABLE_MESSAGE =
  '台账保存失败（浏览器存储不可用或配额已满），本次登记未记账，请处理后重试';

/**
 * 乐观并发提交：把「在 expectedVersion 版本上产出的 next」原子落盘。
 *
 * 顺序固定为「重新读取 → 比对版本 → 往返校验 → 写入」，全程同步完成：
 * 同源标签页的 storage 事件不会在本标签页触发，JavaScript 单线程也保证
 * 比对与写入之间不会插入其他写入。
 *
 * - conflict：存储版本 ≠ expectedVersion（其他页面先提交，或存储被外部清空）；
 *   不写入，返回存储中的最新完整台账。
 * - rejected：next 无法通过序列化往返校验；不写入，保留旧文档。
 * - unavailable：读取或 setItem 抛错（配额 / 安全策略）；不写入，保留旧文档。
 *
 * 成功时文档版本 = expectedVersion + 1。
 */
export function commitLedger(
  storage: StorageLike | undefined,
  expectedVersion: number,
  next: LedgerState,
): CommitResult {
  if (!storage) {
    // 无存储环境（SSR / 禁用）：没有可同步的文档，直接判定为不可用
    return { ok: false, reason: 'unavailable', stored: EMPTY_LEDGER };
  }

  let storedJson: string | null;
  try {
    storedJson = storage.getItem(LEDGER_STORAGE_KEY);
  } catch {
    return { ok: false, reason: 'unavailable', stored: EMPTY_LEDGER };
  }
  const stored = storedJson === null ? EMPTY_LEDGER : parseLedger(storedJson) ?? EMPTY_LEDGER;
  if (stored.version !== expectedVersion) {
    return { ok: false, reason: 'conflict', stored };
  }

  const committed: LedgerState = { ...next, version: expectedVersion + 1 };
  const json = serializeLedger(committed);
  if (parseLedger(json) === null) {
    return { ok: false, reason: 'rejected', stored };
  }
  try {
    storage.setItem(LEDGER_STORAGE_KEY, json);
  } catch {
    return { ok: false, reason: 'unavailable', stored };
  }
  return { ok: true, state: committed };
}

/** 失败原因 → 界面提示文案。 */
export function commitFailureMessage(reason: CommitFailureReason): string {
  if (reason === 'conflict') return COMMIT_CONFLICT_MESSAGE;
  if (reason === 'unavailable') return COMMIT_UNAVAILABLE_MESSAGE;
  // rejected 正常不会经界面命令产生（领域命令已拒绝非法数值），按存储失败处理
  return COMMIT_UNAVAILABLE_MESSAGE;
}

/** 浏览器环境下的默认存储；SSR / 测试环境下为 undefined。 */
export function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
