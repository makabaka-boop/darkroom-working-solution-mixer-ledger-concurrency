import { useEffect, useMemo, useRef, useState } from 'react';
import {
  computeMix,
  validateInputs,
  N_MIN,
  N_MAX,
  TANKS_MIN,
  TANKS_MAX,
  VOLUME_MIN,
  VOLUME_MAX,
  type MeasureStep,
  type RawInputs,
} from './lib/dilution';
import {
  createBatch,
  defaultLedgerDeps,
  validateBatchName,
  validateCapacityInput,
  type LedgerState,
  type MixSourceSnapshot,
} from './lib/capacityLedger';
import {
  browserStorage,
  commitFailureMessage,
  commitLedger,
  LEDGER_STORAGE_KEY,
  loadLedger,
  parseLedger,
} from './lib/ledgerStorage';
import { loadSafelightState, saveSafelightState } from './lib/safelightStorage';
import type { SafelightState } from './lib/safelightTest';
import Ledger from './Ledger';
import Safelight from './Safelight';

type View = 'mix' | 'ledger' | 'safelight';

const FIELDS: Array<{
  key: keyof RawInputs;
  label: string;
  hint: string;
  testId: string;
  errorTestId: string;
}> = [
  {
    key: 'n',
    label: '稀释式 1 + n',
    hint: `n 为 ${N_MIN}–${N_MAX} 的整数`,
    testId: 'input-n',
    errorTestId: 'error-n',
  },
  {
    key: 'total',
    label: '目标总量 (mL)',
    hint: `${VOLUME_MIN}–${VOLUME_MAX} mL 的整数`,
    testId: 'input-total',
    errorTestId: 'error-total',
  },
  {
    key: 'capacity',
    label: '量筒容量 (mL)',
    hint: `${VOLUME_MIN}–${VOLUME_MAX} mL 的整数`,
    testId: 'input-capacity',
    errorTestId: 'error-capacity',
  },
  {
    key: 'tanks',
    label: '显影罐数量',
    hint: `${TANKS_MIN}–${TANKS_MAX} 的整数`,
    testId: 'input-tanks',
    errorTestId: 'error-tanks',
  },
];

export default function App() {
  // 默认进入配液计算；容量台账、安全灯测试通过顶部入口切换，三者状态互不干扰。
  const [view, setView] = useState<View>('mix');
  const [raw, setRaw] = useState<RawInputs>({ n: '4', total: '1000', capacity: '250', tanks: '1' });
  const [checked, setChecked] = useState<boolean[]>([]);

  // 容量台账状态由本组件持有。任何写入都走 commitLedgerState 的
  // 「重新读取 → 版本比对 → 原子写入」协议，绝不在本地乐观扣减后无条件覆盖存储；
  // 另通过 storage 事件实时同步其他标签页的写入，所有页面最终显示同一台账。
  const storage = useMemo(() => browserStorage(), []);
  const [ledger, setLedger] = useState<LedgerState>(() => loadLedger(browserStorage()));
  // 始终保存本页已知的最新台账：提交时作为版本依据，避免闭包读到旧 state。
  const ledgerRef = useRef(ledger);
  ledgerRef.current = ledger;
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const ledgerDeps = useMemo(() => defaultLedgerDeps(), []);

  // 其他标签页成功写入（或清空）台账后，浏览器在本页派发 storage 事件：
  // 直接以存储内容为准刷新本页，操作员不会继续按过期的批次状态 / 剩余量提交。
  // 本标签页自己的写入不触发 storage 事件（提交成功时已同步更新），无需去重。
  useEffect(() => {
    if (!storage || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return;
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== LEDGER_STORAGE_KEY) return;
      const next = event.newValue === null ? loadLedger(storage) : parseLedger(event.newValue);
      if (next) {
        ledgerRef.current = next;
        setLedger(next);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [storage]);

  /**
   * 原子提交命令产出的新状态。
   * 成功：状态与存储一致（版本 +1）；失败：其他标签页先写入（conflict）或
   * 存储拒绝写入（unavailable / rejected），当前动作被拒绝，本页同步到存储中的
   * 最后完整台账并把原因返回给调用方就地提示。任何情况下都不产生「看似成功、
   * 刷新后回滚」的本地假象。
   */
  const commitLedgerState = (next: LedgerState): { ok: true } | { ok: false; message: string } => {
    const result = commitLedger(storage, ledgerRef.current.version, next);
    if (result.ok) {
      ledgerRef.current = result.state;
      setLedger(result.state);
      return { ok: true };
    }
    ledgerRef.current = result.stored;
    setLedger(result.stored);
    return { ok: false, message: commitFailureMessage(result.reason) };
  };

  // 安全灯测试状态由本组件持有并持久化到独立的 localStorage 键，与台账互不影响。
  // 存档损坏时 loadSafelightState 报告 corrupted，界面就地提示。
  const [safelightLoad] = useState(() => loadSafelightState(browserStorage()));
  const [safelight, setSafelight] = useState<SafelightState>(safelightLoad.state);
  const [safelightCorrupted, setSafelightCorrupted] = useState(safelightLoad.corrupted);
  // 存档损坏时只在当前页面回退到空白视图：禁止首屏 effect 把浏览器中的
  // 原文档覆盖成空记录（否则最近一次可追溯数据会在未经确认时永久丢失）。
  // 只有命令成功产出新数据（创建 / 评估）后 handleSafelightChange 清除损坏标记，
  // 之后的写入才是操作员有意开始的新记录。
  useEffect(() => {
    if (safelightCorrupted) return;
    saveSafelightState(browserStorage(), safelight);
  }, [safelight, safelightCorrupted]);

  const handleSafelightChange = (next: SafelightState) => {
    // 新数据由命令产出，覆盖损坏存档是操作员的有意行为，提示随之消失
    setSafelightCorrupted(false);
    setSafelight(next);
  };

  // 「存入容量台账」表单（仅在配液结果合法时出现）
  const [storeName, setStoreName] = useState('');
  const [storeCapacity, setStoreCapacity] = useState('');
  const [storeNameError, setStoreNameError] = useState<string | null>(null);
  const [storeCapacityError, setStoreCapacityError] = useState<string | null>(null);
  // 台账侧提交被拒（其他标签页先写入 / 存储失败）：在配液页就地横幅说明，
  // 不切换页面，批次并未创建，草稿保留以便核对后重试。
  const [storeWriteError, setStoreWriteError] = useState<string | null>(null);

  // 每次输入变化都重新校验、重新计算；任一字段非法则 result 为 null，
  // 旧配液卡随之卸载，不会残留。
  const { inputs, errors } = useMemo(() => validateInputs(raw), [raw]);
  const result = useMemo(() => (inputs ? computeMix(inputs) : null), [inputs]);

  // 展示步骤 = 各罐步骤按罐号顺序拼接（罐数为 1 时即整批步骤）。
  const displaySteps = useMemo(
    () => (result ? result.tankPlans.flatMap((tank) => tank.steps) : []),
    [result],
  );
  // 每罐第一步在展示序列中的下标，用于定位跨罐的勾选状态。
  const tankOffsets = useMemo(() => {
    if (!result) return [];
    const offsets: number[] = [];
    let next = 0;
    for (const tank of result.tankPlans) {
      offsets.push(next);
      next += tank.steps.length;
    }
    return offsets;
  }, [result]);

  // 任一参数变化都会得到新的 result，全部勾选状态随之清空。
  useEffect(() => {
    setChecked(displaySteps.map(() => false));
  }, [displaySteps]);

  // 待建档的名称 / 额定容量只从属于「当前这一次」配液参数：
  // 参数一变化（含变为非法导致结果消失）就重置草稿与错误，
  // 避免旧名称、旧额定容量附着在新计算结果上被误存入台账。
  // 依赖原始参数串而非 result：切换顶部标签页会重挂载结果区、产生新的 result，
  // 但参数未变，草稿应保留（与配液表单/结果跨标签保留的行为一致）。
  const rawSignature = `${raw.n}|${raw.total}|${raw.capacity}|${raw.tanks}`;
  useEffect(() => {
    setStoreName('');
    setStoreCapacity('');
    setStoreNameError(null);
    setStoreCapacityError(null);
    setStoreWriteError(null);
  }, [rawSignature]);

  const doneCount = checked.filter(Boolean).length;
  const stepsSum = displaySteps.reduce((sum, s) => sum + s.amount, 0);
  const cardDate = useMemo(() => new Date().toLocaleDateString('zh-CN'), [result]);

  const setField = (key: keyof RawInputs) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setRaw((prev) => ({ ...prev, [key]: event.target.value }));
  };

  const toggleStep = (index: number) => {
    setChecked((prev) => prev.map((value, i) => (i === index ? !value : value)));
  };

  // 把本次配液结果连同批次一并写入容量台账，随后切换过去展示来源摘要。
  // 名称或容量校验失败时就地说明原因：不切换页面、不写入台账。
  const submitStoreToLedger = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!result) return;
    setStoreWriteError(null);
    const nameErr = validateBatchName(storeName);
    const capacityErr = validateCapacityInput(storeCapacity);
    setStoreNameError(nameErr ?? null);
    setStoreCapacityError(capacityErr ?? null);
    if (nameErr || capacityErr) return;

    // 快照逐字段取自当前这一次计算结果（同一 result），不做任何重算
    const mixSource: MixSourceSnapshot = {
      n: result.n,
      total: result.total,
      capacity: result.capacity,
      tanks: result.tanks,
      concentrate: result.concentrate,
      water: result.water,
    };
    const created = createBatch(
      ledgerRef.current,
      { name: storeName, capacity: storeCapacity, mixSource },
      ledgerDeps,
    );
    if (!created.ok) {
      // 命令级失败同样就地说明，不切换页面、不写入台账
      setStoreCapacityError(created.error);
      return;
    }
    // 原子提交：其他标签页先写入（新建了批次 / 登记了记录）或存储失败时，
    // 本批次不创建、不切换页面，横幅说明并保留草稿；台账已同步为存储内容。
    const committed = commitLedgerState(created.state);
    if (!committed.ok) {
      setStoreWriteError(committed.message);
      return;
    }
    setSelectedBatchId(created.value.id);
    setStoreName('');
    setStoreCapacity('');
    setView('ledger');
  };

  // tankNumber 仅在分罐时传入：步骤名称必须显式包含罐号，
  // 否则不同罐中相同的液体/次数步骤对读屏用户无法区分。
  const renderStep = (step: MeasureStep, index: number, capacity: number, tankNumber?: number) => (
    <li key={`${step.liquid}-${step.step}-${index}`} data-testid="measure-step">
      <label className={checked[index] ? 'step step--done' : 'step'}>
        <input
          type="checkbox"
          data-testid="step-checkbox"
          checked={checked[index] ?? false}
          onChange={() => toggleStep(index)}
        />
        <span>
          {tankNumber !== undefined && `罐 ${tankNumber}：`}
          {step.liquidLabel} 第 {step.step}/{step.ofSteps} 次：量取{' '}
          <strong data-testid="step-amount">{step.amount}</strong> mL
          {step.amount === capacity ? '（满量筒）' : '（余量）'}
        </span>
      </label>
    </li>
  );

  return (
    <div className="app">
      <header className="no-print">
        <h1>暗房配液台</h1>
        <p className="tagline">按 1+n 稀释式计算浓缩液与清水，自动拆分量筒量取步骤</p>
        <nav className="view-nav" aria-label="功能切换">
          <button
            type="button"
            className={`nav-tab${view === 'mix' ? ' nav-tab--active' : ''}`}
            data-testid="nav-mix"
            aria-pressed={view === 'mix'}
            onClick={() => setView('mix')}
          >
            配液计算
          </button>
          <button
            type="button"
            className={`nav-tab${view === 'ledger' ? ' nav-tab--active' : ''}`}
            data-testid="nav-ledger"
            aria-pressed={view === 'ledger'}
            onClick={() => setView('ledger')}
          >
            容量台账
          </button>
          <button
            type="button"
            className={`nav-tab${view === 'safelight' ? ' nav-tab--active' : ''}`}
            data-testid="nav-safelight"
            aria-pressed={view === 'safelight'}
            onClick={() => setView('safelight')}
          >
            安全灯测试
          </button>
        </nav>
      </header>

      {view === 'ledger' ? (
        <main>
          <Ledger
            ledger={ledger}
            commitLedgerState={commitLedgerState}
            selectedId={selectedBatchId}
            onSelectBatch={setSelectedBatchId}
          />
        </main>
      ) : view === 'safelight' ? (
        <main>
          <Safelight
            safelight={safelight}
            onSafelightChange={handleSafelightChange}
            storageCorrupted={safelightCorrupted}
          />
        </main>
      ) : (
      <main>
        <section className="panel no-print" aria-label="配液参数">
          <div className="fields">
            {FIELDS.map(({ key, label, hint, testId, errorTestId }) => (
              <div className={`field${errors[key] ? ' field--invalid' : ''}`} key={key}>
                <label htmlFor={testId}>{label}</label>
                <input
                  id={testId}
                  data-testid={testId}
                  inputMode="numeric"
                  value={raw[key]}
                  onChange={setField(key)}
                  aria-invalid={Boolean(errors[key])}
                  aria-describedby={`${errorTestId} ${testId}-hint`}
                />
                <small id={`${testId}-hint`} className="hint">
                  {hint}
                </small>
                {errors[key] && (
                  <p className="error" role="alert" id={errorTestId} data-testid={errorTestId}>
                    {errors[key]}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>

        {result && (
          <>
            <section className="panel result no-print" data-testid="result-card" aria-label="配液结果">
              <h2>
                配液结果 <span className="ratio">1+{result.n}</span>
                {result.tanks > 1 && <span className="ratio">{result.tanks} 罐</span>}
              </h2>
              <dl className="summary">
                <div>
                  <dt>浓缩液</dt>
                  <dd data-testid="result-concentrate">{result.concentrate} mL</dd>
                </div>
                <div>
                  <dt>清水</dt>
                  <dd data-testid="result-water">{result.water} mL</dd>
                </div>
                <div>
                  <dt>合计</dt>
                  <dd data-testid="result-total">{result.concentrate + result.water} mL</dd>
                </div>
              </dl>
              <p className="note" data-testid="result-exact">
                浓缩液精确值 {result.exactConcentrate.toFixed(2)} mL，按 0.5 mL 为界取整为{' '}
                {result.concentrate} mL；清水 = 目标总量 {result.total} mL − 取整后浓缩液。
              </p>

              {result.tanks === 1 ? (
                <>
                  <h3>
                    量取步骤
                    <span
                      className="progress"
                      data-testid="steps-progress"
                      role="status"
                      aria-live="polite"
                      aria-atomic="true"
                    >
                      已勾选 {doneCount}/{displaySteps.length}
                    </span>
                  </h3>
                  <ol className="steps">
                    {displaySteps.map((step, index) => renderStep(step, index, result.capacity))}
                  </ol>
                </>
              ) : (
                <>
                  <p className="note" data-testid="tank-note">
                    整批工作液只算一次，按下表分装 {result.tanks} 只显影罐：目标总量与浓缩液分别均分，
                    余量依次补给前面的罐，各罐总量相差不超过 1 mL。
                  </p>
                  <h3>
                    分罐量取步骤
                    <span
                      className="progress"
                      data-testid="steps-progress"
                      role="status"
                      aria-live="polite"
                      aria-atomic="true"
                    >
                      已勾选 {doneCount}/{displaySteps.length}
                    </span>
                  </h3>
                  {result.tankPlans.map((tank, tankIndex) => (
                    <section className="tank-plan" data-testid="tank-plan" key={tank.index}>
                      <h4 data-testid="tank-title">
                        罐 {tank.index}：目标 {tank.total} mL ＝ 浓缩液 {tank.concentrate} mL ＋ 清水{' '}
                        {tank.water} mL
                      </h4>
                      <ol className="steps">
                        {tank.steps.map((step, i) =>
                          renderStep(step, tankOffsets[tankIndex] + i, result.capacity, tank.index),
                        )}
                      </ol>
                    </section>
                  ))}
                </>
              )}
              <p className="note" data-testid="steps-sum">
                校验：每步 ≤ 量筒容量 {result.capacity} mL；各步合计 {stepsSum} mL = 目标总量{' '}
                {result.total} mL{stepsSum === result.total ? ' ✓' : ' ✗'}
              </p>

              <button type="button" className="print-button" onClick={() => window.print()}>
                打印配液卡
              </button>

              <div className="store-ledger" data-testid="store-to-ledger">
                <h3>存入容量台账</h3>
                {storeWriteError && (
                  <p className="write-error" role="alert" data-testid="store-write-error">
                    {storeWriteError}
                  </p>
                )}
                <p className="note">
                  把本次配液参数（1+{result.n}、总量 {result.total} mL、显影罐 {result.tanks}{' '}
                  只）随批次固定保存，台账中可追溯来源。
                </p>
                <form onSubmit={submitStoreToLedger} noValidate>
                  <div className="fields">
                    <div className={`field${storeNameError ? ' field--invalid' : ''}`}>
                      <label htmlFor="store-name-input">药液批次名称</label>
                      <input
                        id="store-name-input"
                        data-testid="store-name-input"
                        value={storeName}
                        onChange={(event) => {
                          setStoreName(event.target.value);
                          setStoreNameError(null);
                        }}
                        aria-invalid={Boolean(storeNameError)}
                        aria-describedby="error-store-name store-name-hint"
                      />
                      <small id="store-name-hint" className="hint">
                        如：D-76 显影液（2026-09 配制）
                      </small>
                      {storeNameError && (
                        <p
                          className="error"
                          role="alert"
                          id="error-store-name"
                          data-testid="error-store-name"
                        >
                          {storeNameError}
                        </p>
                      )}
                    </div>
                    <div className={`field${storeCapacityError ? ' field--invalid' : ''}`}>
                      <label htmlFor="store-capacity-input">额定处理容量（等效胶片数）</label>
                      <input
                        id="store-capacity-input"
                        data-testid="store-capacity-input"
                        inputMode="numeric"
                        value={storeCapacity}
                        onChange={(event) => {
                          setStoreCapacity(event.target.value);
                          setStoreCapacityError(null);
                        }}
                        aria-invalid={Boolean(storeCapacityError)}
                        aria-describedby="error-store-capacity store-capacity-hint"
                      />
                      <small id="store-capacity-hint" className="hint">
                        整批药液可处理的等效胶片总数，正整数
                      </small>
                      {storeCapacityError && (
                        <p
                          className="error"
                          role="alert"
                          id="error-store-capacity"
                          data-testid="error-store-capacity"
                        >
                          {storeCapacityError}
                        </p>
                      )}
                    </div>
                  </div>
                  <button
                    type="submit"
                    className="action-button"
                    data-testid="store-to-ledger-button"
                  >
                    存入容量台账
                  </button>
                </form>
              </div>
            </section>

            {result.tanks === 1 ? (
              <section className="print-card" data-testid="print-card" aria-label="配液卡">
                <h2>暗房配液卡</h2>
                <table>
                  <tbody>
                    <tr>
                      <th>日期</th>
                      <td>{cardDate}</td>
                      <th>稀释式</th>
                      <td>1+{result.n}</td>
                    </tr>
                    <tr>
                      <th>目标总量</th>
                      <td>{result.total} mL</td>
                      <th>量筒容量</th>
                      <td>{result.capacity} mL</td>
                    </tr>
                    <tr>
                      <th>浓缩液</th>
                      <td>{result.concentrate} mL</td>
                      <th>清水</th>
                      <td>{result.water} mL</td>
                    </tr>
                  </tbody>
                </table>
                <h3>量取步骤</h3>
                <table>
                  <thead>
                    <tr>
                      <th>✓</th>
                      <th>液体</th>
                      <th>次数</th>
                      <th>体积</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.steps.map((step, stepIndex) => (
                      <tr key={`card-${step.liquid}-${step.step}`}>
                        <td className="box" data-testid="print-step-box">
                          {checked[stepIndex] ? '☑' : '☐'}
                        </td>
                        <td>{step.liquidLabel}</td>
                        <td>
                          {step.step}/{step.ofSteps}
                        </td>
                        <td>{step.amount} mL</td>
                      </tr>
                    ))}
                    <tr className="total-row">
                      <td colSpan={3}>合计</td>
                      <td>{stepsSum} mL</td>
                    </tr>
                  </tbody>
                </table>
                <p className="sign">配制人：＿＿＿＿＿＿　复核人：＿＿＿＿＿＿</p>
              </section>
            ) : (
              <section className="print-card" data-testid="print-card" aria-label="配液卡">
                <h2>暗房配液卡</h2>
                <table>
                  <tbody>
                    <tr>
                      <th>日期</th>
                      <td>{cardDate}</td>
                      <th>稀释式</th>
                      <td>1+{result.n}</td>
                    </tr>
                    <tr>
                      <th>目标总量</th>
                      <td>{result.total} mL</td>
                      <th>量筒容量</th>
                      <td>{result.capacity} mL</td>
                    </tr>
                    <tr>
                      <th>浓缩液</th>
                      <td>{result.concentrate} mL</td>
                      <th>清水</th>
                      <td>{result.water} mL</td>
                    </tr>
                    <tr>
                      <th>显影罐数量</th>
                      <td colSpan={3}>{result.tanks} 只</td>
                    </tr>
                  </tbody>
                </table>
                {result.tankPlans.map((tank, tankIndex) => (
                  <div key={`print-tank-${tank.index}`} data-testid="print-tank">
                    <h3>
                      罐 {tank.index}：目标 {tank.total} mL（浓缩液 {tank.concentrate} mL ＋ 清水{' '}
                      {tank.water} mL）
                    </h3>
                    <table>
                      <thead>
                        <tr>
                          <th>✓</th>
                          <th>液体</th>
                          <th>次数</th>
                          <th>体积</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tank.steps.map((step, stepIndex) => (
                          <tr key={`card-tank-${tank.index}-${step.liquid}-${step.step}`}>
                            <td className="box" data-testid="print-step-box">
                              {checked[tankOffsets[tankIndex] + stepIndex] ? '☑' : '☐'}
                            </td>
                            <td>{step.liquidLabel}</td>
                            <td>
                              {step.step}/{step.ofSteps}
                            </td>
                            <td>{step.amount} mL</td>
                          </tr>
                        ))}
                        <tr className="total-row">
                          <td colSpan={3}>罐 {tank.index} 合计</td>
                          <td>{tank.total} mL</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                ))}
                <p className="batch-total" data-testid="print-batch-total">
                  整批合计 {result.total} mL（浓缩液 {result.concentrate} mL ＋ 清水 {result.water}{' '}
                  mL）
                </p>
                <p className="sign">配制人：＿＿＿＿＿＿　复核人：＿＿＿＿＿＿</p>
              </section>
            )}
          </>
        )}
      </main>
      )}
    </div>
  );
}
