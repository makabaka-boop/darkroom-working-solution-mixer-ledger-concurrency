import { useEffect, useMemo, useState } from 'react';
import {
  BATCH_STATUS_LABEL,
  batchRecords,
  batchStatus,
  createBatch,
  defaultLedgerDeps,
  recordUsage,
  remainingCapacity,
  usedCapacity,
  validateBatchName,
  validateCapacityInput,
  validateFilmsInput,
  type LedgerState,
} from './lib/capacityLedger';

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false });
}

export interface LedgerProps {
  /** 当前台账状态（由 App 持有：提交成功或外部标签页写入后更新） */
  ledger: LedgerState;
  /**
   * 原子提交一条命令产出的新状态。
   * 返回提交结果：成功时界面已同步为新台账；失败（其他标签页先写入 /
   * 存储拒绝写入）时当前动作被整体拒绝，界面同步回存储中的最后完整台账。
   */
  commitLedgerState: (next: LedgerState) => { ok: true } | { ok: false; message: string };
  /** 当前选中的批次 id（由 App 持有，配液建档后可跳转选中） */
  selectedId: string | null;
  onSelectBatch: (id: string | null) => void;
}

/**
 * 容量台账视图：创建药液批次 → 选中批次登记用量 → 按时间查看使用记录。
 *
 * 跨标签页安全：所有写入都不在本地先「乐观」更新，而是交给 commitLedgerState
 * 做「重新读取 → 版本比对 → 原子写入」。其他标签页已先写入或浏览器存储拒绝写入时，
 * 当前动作被拒绝：本视图不显示任何未记账的成功状态与扣减，改显示横幅说明原因，
 * 并自动呈现存储中的最后完整台账（批次、记录顺序、剩余量与所有页面一致）。
 *
 * 从配液计算「存入容量台账」建立的批次带有配液来源快照，选中后展示来源摘要。
 */
export default function Ledger({ ledger, commitLedgerState, selectedId, onSelectBatch }: LedgerProps) {
  const deps = useMemo(() => defaultLedgerDeps(), []);

  // 新建批次表单
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [capacityError, setCapacityError] = useState<string | null>(null);

  // 登记用量表单
  const [films, setFilms] = useState('');
  const [note, setNote] = useState('');
  const [filmsError, setFilmsError] = useState<string | null>(null);

  // 提交被拒（其他标签页先写入 / 存储失败）时的横幅；
  // 与字段级错误分开：字段非法由字段下方提示，且根本不会进入提交流程。
  const [writeError, setWriteError] = useState<string | null>(null);

  const selected = ledger.batches.find((batch) => batch.id === selectedId) ?? null;
  const selectedRecords = selected ? batchRecords(ledger, selected.id) : [];

  // 切换（或取消）选中批次时，丢弃上一批尚未提交的用量 / 备注草稿与错误，
  // 避免操作员在 A 批次填写后直接记到 B 批次（跨批次误登记）。
  // 仅随选中批次变化触发：同批次内登记成功后由提交逻辑自行清空输入。
  const selectedKey = selected?.id ?? null;
  useEffect(() => {
    setFilms('');
    setNote('');
    setFilmsError(null);
  }, [selectedKey]);

  const submitCreate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setWriteError(null);
    // 先把字段级错误放到对应输入框下方；命令仍会再校验一次（最终闸门）。
    const nameErr = validateBatchName(name);
    const capacityErr = validateCapacityInput(capacity);
    setNameError(nameErr ?? null);
    setCapacityError(capacityErr ?? null);
    if (nameErr || capacityErr) return;

    const result = createBatch(ledger, { name, capacity }, deps);
    if (!result.ok) {
      setCapacityError(result.error);
      return;
    }
    // 原子提交：版本不符（其他标签页先写入）或存储失败时整体拒绝，
    // 不清空表单、不显示新批次，由横幅说明；台账内容以存储为准（已同步）。
    const committed = commitLedgerState(result.state);
    if (!committed.ok) {
      setWriteError(committed.message);
      return;
    }
    onSelectBatch(result.value.id);
    setName('');
    setCapacity('');
  };

  const submitUsage = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    setWriteError(null);
    const filmsErr = validateFilmsInput(films);
    setFilmsError(filmsErr ?? null);
    if (filmsErr) return;

    const result = recordUsage(ledger, { batchId: selected.id, films, note }, deps);
    if (!result.ok) {
      // 超过剩余容量等命令级错误同样就地说明，且不写入任何记录
      setFilmsError(result.error);
      return;
    }
    // 原子提交：绝不先在本地扣减余量。其他标签页先写入（可能已耗尽本批）
    // 或存储拒绝写入时，本动作被拒绝，记录不出现、余量不变，横幅说明原因；
    // 操作员可按已刷新的最新剩余容量核对后用保留的草稿重新提交。
    const committed = commitLedgerState(result.state);
    if (!committed.ok) {
      setWriteError(committed.message);
      return;
    }
    setFilms('');
    setNote('');
  };

  return (
    <>
      {writeError && (
        <p className="write-error" role="alert" data-testid="ledger-write-error">
          {writeError}
        </p>
      )}
      <section className="panel no-print" aria-label="新建药液批次">
        <h2 className="panel-title">新建药液批次</h2>
        <form onSubmit={submitCreate} noValidate>
          <div className="fields">
            <div className={`field${nameError ? ' field--invalid' : ''}`}>
              <label htmlFor="batch-name-input">药液名称</label>
              <input
                id="batch-name-input"
                data-testid="batch-name-input"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError(null);
                }}
                aria-invalid={Boolean(nameError)}
                aria-describedby="error-batch-name batch-name-hint"
              />
              <small id="batch-name-hint" className="hint">
                如：D-76 显影液（2026-09 配制）
              </small>
              {nameError && (
                <p className="error" role="alert" id="error-batch-name" data-testid="error-batch-name">
                  {nameError}
                </p>
              )}
            </div>
            <div className={`field${capacityError ? ' field--invalid' : ''}`}>
              <label htmlFor="batch-capacity-input">额定容量（等效胶片数）</label>
              <input
                id="batch-capacity-input"
                data-testid="batch-capacity-input"
                inputMode="numeric"
                value={capacity}
                onChange={(event) => {
                  setCapacity(event.target.value);
                  setCapacityError(null);
                }}
                aria-invalid={Boolean(capacityError)}
                aria-describedby="error-batch-capacity batch-capacity-hint"
              />
              <small id="batch-capacity-hint" className="hint">
                整批药液可处理的等效胶片总数，正整数
              </small>
              {capacityError && (
                <p
                  className="error"
                  role="alert"
                  id="error-batch-capacity"
                  data-testid="error-batch-capacity"
                >
                  {capacityError}
                </p>
              )}
            </div>
          </div>
          <button type="submit" className="action-button" data-testid="create-batch-button">
            创建批次
          </button>
        </form>
      </section>

      <section className="panel no-print" aria-label="药液批次列表">
        <h2 className="panel-title">药液批次</h2>
        {ledger.batches.length === 0 ? (
          <p className="note" data-testid="batch-empty">
            还没有药液批次，请先在上方创建。
          </p>
        ) : (
          <ul className="batch-list" data-testid="batch-list">
            {ledger.batches.map((batch) => {
              const status = batchStatus(batch, ledger);
              const isSelected = batch.id === selectedId;
              return (
                <li key={batch.id}>
                  <button
                    type="button"
                    className={`batch-item${isSelected ? ' batch-item--selected' : ''}`}
                    data-testid="batch-item"
                    aria-pressed={isSelected}
                    onClick={() => {
                      onSelectBatch(batch.id);
                    }}
                  >
                    <span className="batch-item__head">
                      <strong data-testid="batch-name">{batch.name}</strong>
                      <span className={`status status--${status}`} data-testid="batch-status">
                        {BATCH_STATUS_LABEL[status]}
                      </span>
                    </span>
                    <span className="batch-item__meta">
                      累计用量 <strong data-testid="batch-used">{usedCapacity(ledger, batch.id)}</strong>
                      　剩余 <strong data-testid="batch-remaining">
                        {remainingCapacity(batch, ledger)}
                      </strong>
                      　额定 <span data-testid="batch-capacity">{batch.capacity}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {selected && (
        <section className="panel no-print" aria-label="登记用量" data-testid="usage-panel">
          <h2 className="panel-title">登记用量：{selected.name}</h2>
          <dl className="summary">
            <div>
              <dt>累计用量</dt>
              <dd data-testid="detail-used">{usedCapacity(ledger, selected.id)}</dd>
            </div>
            <div>
              <dt>剩余容量</dt>
              <dd data-testid="detail-remaining">{remainingCapacity(selected, ledger)}</dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd data-testid="detail-status">{BATCH_STATUS_LABEL[batchStatus(selected, ledger)]}</dd>
            </div>
          </dl>
          {selected.mixSource && (
            <p className="mix-source" data-testid="mix-source-summary">
              配液来源：稀释式 1+{selected.mixSource.n}，目标总量 {selected.mixSource.total} mL，
              量筒容量 {selected.mixSource.capacity} mL，显影罐 {selected.mixSource.tanks} 只，
              浓缩液 {selected.mixSource.concentrate} mL ＋ 清水 {selected.mixSource.water} mL
            </p>
          )}
          {batchStatus(selected, ledger) === 'exhausted' && (
            <p className="note" data-testid="exhausted-note">
              本批药液已耗尽，请配制新批次，不要继续使用。
            </p>
          )}

          <form onSubmit={submitUsage} noValidate>
            <div className="fields">
              <div className={`field${filmsError ? ' field--invalid' : ''}`}>
                <label htmlFor="films-input">本次处理（等效胶片数）</label>
                <input
                  id="films-input"
                  data-testid="films-input"
                  inputMode="numeric"
                  value={films}
                  onChange={(event) => {
                    setFilms(event.target.value);
                    setFilmsError(null);
                  }}
                  aria-invalid={Boolean(filmsError)}
                  aria-describedby="error-films films-hint"
                />
                <small id="films-hint" className="hint">
                  正整数，不得超过剩余容量
                </small>
                {filmsError && (
                  <p className="error" role="alert" id="error-films" data-testid="error-films">
                    {filmsError}
                  </p>
                )}
              </div>
              <div className="field">
                <label htmlFor="note-input">备注（可选）</label>
                <input
                  id="note-input"
                  data-testid="note-input"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  aria-describedby="note-hint"
                />
                <small id="note-hint" className="hint">
                  如：4 卷 135，正常冲洗
                </small>
              </div>
            </div>
            <button type="submit" className="action-button" data-testid="record-usage-button">
              登记用量
            </button>
          </form>

          <h3 className="records-title">使用记录</h3>
          {selectedRecords.length === 0 ? (
            <p className="note" data-testid="usage-empty">
              暂无使用记录。
            </p>
          ) : (
            <ol className="usage-list" data-testid="usage-list">
              {selectedRecords.map((record) => (
                <li key={record.id} className="usage-item" data-testid="usage-item">
                  <span className="usage-item__time" data-testid="usage-time">
                    {formatTime(record.createdAt)}
                  </span>
                  <span>
                    处理 <strong data-testid="usage-films">{record.films}</strong>（等效胶片）
                    {record.note !== '' && <em data-testid="usage-note">　备注：{record.note}</em>}
                  </span>
                  <span className="usage-item__remaining">
                    剩余 <strong data-testid="usage-remaining">{record.remainingAfter}</strong>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </>
  );
}
