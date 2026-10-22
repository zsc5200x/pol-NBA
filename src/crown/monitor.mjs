import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { CrownStore } from './store.mjs';
import { CrownClient } from './client.mjs';
import { loadConfig, readJson, verifyEvidence } from './config.mjs';
import { CrownError, decode, parseList, parseMarkets, coverageFor, scalar, at } from './parser.mjs';
import { compareMarkets } from './matching.mjs';

export const ERRORS = {
 NOT_CONFIGURED:'皇冠尚未配置：需要本机安全会话和经真实响应核对的字段映射。', CONFIG_UNREADABLE:'安全配置不可读取或 JSON 无效。',
 INVALID_CONFIG:'安全配置内容无效。', REQUEST_UNVERIFIED:'实际请求参数没有对应的脱敏 Network 捕获，拒绝猜测分类或请求字段。', MAPPING_UNVERIFIED:'真实请求或字段映射尚未验证，未发起采集。', EVIDENCE_MISSING:'找不到本机脱敏捕获证据。', EVIDENCE_CHANGED:'捕获文件校验值不匹配，请重新核对映射。',
 SESSION_MISSING:'缺少有效本机会话，请在本机安全文件中更新，不要把凭据粘贴到聊天或页面。', SESSION_PERMISSIONS:'会话文件权限过宽，请在本机将权限设为 600。',
 ACCESS_OR_SESSION_DENIED:'接口拒绝访问或会话已失效，请在本机检查有效会话及网络。', SESSION_EXPIRED:'已验证的会话失效标记被触发，请更新本机会话。',
 NETWORK_ERROR:'皇冠网络请求失败，保留旧数据并等待重试。', TIMEOUT:'皇冠请求超时，正在退避重试。', HTTP_429:'皇冠接口限流，正在退避重试。', HTTP_5XX:'皇冠接口服务异常，正在退避重试。', HTTP_ERROR:'皇冠接口返回异常状态。',
 EMPTY_OR_OVERSIZE:'响应为空或超过允许大小。', INVALID_RESPONSE:'接口返回的数据不能解析。', UNEXPECTED_RESPONSE:'响应结构与已核对样本不符，可能会话失效，未当成空赛程。',
 PAGINATION_UNKNOWN:'分页结构未识别或下一页参数缺失，比赛发现未完成。', PAGINATION_LOOP:'分页游标重复或超过页数上限。', DIRECTION_UNVERIFIED:'让分主客方向映射未确认。', INVALID_MAPPING:'字段映射不完整。', READ_ONLY_ONLY:'拒绝非只读或未捕获的请求操作。',
 SOURCE_MODE_CONFLICT:'响应模式与请求来源冲突，不能按文件名或请求标签当成早盘。', INCOMPLETE_MATCH:'比赛缺少必要字段。', CONFLICTING_MATCH:'同一比赛 ID 的队伍或时间冲突，已停止自动匹配。', DETAIL_FAILED:'部分单场详情请求失败，盘口完整性未验证。', INTERNAL_ERROR:'采集任务异常，详细会话信息不会写入日志。', STOPPED:'采集已停止。',
};
const safeCode = e => Object.hasOwn(ERRORS, e?.code) ? e.code : 'INTERNAL_ERROR';

export class CrownMonitor extends EventEmitter {
  constructor({ configPath = process.env.CROWN_CONFIG_PATH, dbPath = process.env.CROWN_DB_PATH ?? resolve('.local/crown.sqlite'), store, clientFactory = c => new CrownClient(c) } = {}) {
    super();
    this.configPath = configPath; this.store = store ?? new CrownStore(configPath ? dbPath : ':memory:'); this.clientFactory = clientFactory; this.running = false; this.failureCount = 0;
    // Poll progress is separate from the last validated quote set; a restart must revalidate it.
    this.lastDetailState = new Map();
    this.state = { status: configPath ? 'starting' : 'not_configured', errorCode: configPath ? null : 'NOT_CONFIGURED', lastAttemptAt: null, lastSuccessAt: this.store.meta('lastSuccessAt'), discoveryComplete: false, todayIds: [], earlyIds: [], failedIds: [], collectedIds: [], coverage: {}, activeIds: this.store.meta('activeIds') ?? [], mappingVerified: false };
  }
  start() { if (this.running) return; this.running = true; if (this.configPath) void this.cycle(); }
  async stop() { this.running = false; clearTimeout(this.timer); this.abort?.abort(); this.client?.cancel(); if (this.pending) await this.pending; this.store.close(); }
  async request(mode, profile, args, operation) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const root = decode(await this.client.request(mode, profile, { ...args, signal: this.abort.signal }));
        if (profile.invalidSession && profile.invalidSession.values?.map(String).includes(scalar(root, profile.invalidSession.path))) throw new CrownError('SESSION_EXPIRED');
        if (!profile.containerPath || at(root, profile.containerPath) === undefined) throw new CrownError('UNEXPECTED_RESPONSE');
        this.store.task(operation, 'success'); return root;
      } catch (error) {
        const code = safeCode(error); this.store.task(operation, 'failure', code);
        if (!['TIMEOUT', 'NETWORK_ERROR', 'HTTP_429', 'HTTP_5XX'].includes(code) || attempt === 2 || this.abort.signal.aborted) throw new CrownError(code);
        await delay(Math.min(10000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250), undefined, { signal: this.abort.signal });
      }
    }
  }
  async cycle() {
    clearTimeout(this.timer);
    if (this.pending || !this.running) return this.pending;
    this.pending = this.runCycle().finally(() => {
      this.pending = null;
      this.emit('state', this.state);
      if (this.running) this.timer = setTimeout(() => void this.cycle(), Math.min(300000, (this.config?.intervalMs ?? 30000) * 2 ** Math.min(this.failureCount, 4)));
    });
    return this.pending;
  }
  async runCycle() {
    this.abort = new AbortController(); this.state.lastAttemptAt = new Date().toISOString();
    try {
      this.config = await loadConfig(this.configPath); this.state.mappingVerified = true;
      this.client = this.clientFactory(this.config);
      const all = new Map(), conflictIds = new Set(); const modeIds = { today: new Set(), early: new Set() }; let complete = true;
      const modeErrors = [];
      for (const mode of ['today', 'early']) {
        const profile = this.config.lists[mode]; const cursors = new Set(); let page = profile.pagination?.firstPage; let terminal = false;
        try {
          for (let index = 0; index < Math.min(100, profile.pagination?.maxPages ?? 30); index++) {
            const root = await this.request(mode, profile, { page }, `list:${mode}`);
            const result = parseList(root, profile, mode);
            if (result.issues.length) { complete = false; for (const issue of result.issues) { modeErrors.push(issue.code === 'CONFLICTING_MATCH' ? 'CONFLICTING_MATCH' : 'INCOMPLETE_MATCH'); if (issue.code === 'CONFLICTING_MATCH' && issue.id) conflictIds.add(issue.id); } }
            for (const match of result.matches) {
              modeIds[mode].add(match.id);
              const old = all.get(match.id);
              if (old && (old.home !== match.home || old.away !== match.away || old.startTime !== match.startTime)) { conflictIds.add(match.id); complete = false; continue; }
              all.set(match.id, old ? { ...match, sources: [...new Set([...old.sources, mode])] } : match);
            }
            if (!result.more) { complete &&= result.paginationVerified; terminal = true; break; }
            if (cursors.has(result.next)) throw new CrownError('PAGINATION_LOOP');
            cursors.add(result.next); page = result.next;
          }
          if (!terminal) throw new CrownError('PAGINATION_LOOP');
        } catch (error) { complete = false; modeErrors.push(safeCode(error)); }
      }
      for (const id of conflictIds) all.delete(id);
      if (conflictIds.size) modeErrors.push('CONFLICTING_MATCH');
      for (const [id, detailState] of this.lastDetailState) if (!all.has(id)) this.lastDetailState.set(id, { ...detailState, healthy: false });
      this.state.todayIds = [...modeIds.today]; this.state.earlyIds = [...modeIds.early]; this.state.discoveryComplete = complete;
      this.state.failedIds = [...conflictIds]; this.state.collectedIds = []; this.state.coverage = {};
      const previousIds = this.state.activeIds;
      this.state.activeIds = complete ? [...all.keys()] : [...new Set([...previousIds, ...all.keys()])];
      let coverageDocument = null;
      if (this.config.coverageEvidence) {
        await verifyEvidence(this.config.coverageEvidence, this.config.base);
        coverageDocument = await readJson(resolve(this.config.base, this.config.coverageEvidence.path));
      }
      for (const match of all.values()) {
        if (this.abort.signal.aborted) break;
        this.store.upsertMatch(match);
        const markets = new Map(); let detailsComplete = true;
        for (const mode of match.sources) for (const profile of this.config.details[mode]) {
          try {
            const root = await this.request(mode, profile, { gid: match.id }, `detail:${mode}:${profile.id}`);
            const parsed = parseMarkets(root, profile, match, mode);
            if (parsed.issues.length) detailsComplete = false;
            for (const market of parsed.markets) {
              const old = markets.get(market.key);
              if (old && JSON.stringify([old.sides, old.status]) !== JSON.stringify([market.sides, market.status])) { old.parseStatus = 'conflict'; old.status = 'unknown'; detailsComplete = false; }
              else markets.set(market.key, old ? { ...market, sources: [...new Set([...old.sources, ...market.sources])] } : market);
            }
          } catch (error) { detailsComplete = false; this.state.failedIds.push(match.id); this.state.errorCode = safeCode(error); }
        }
        this.store.transaction(() => { for (const market of markets.values()) this.store.saveMarket(market); });
        this.lastDetailState.set(match.id, { healthy: detailsComplete, marketKeys: detailsComplete ? new Set(markets.keys()) : this.lastDetailState.get(match.id)?.marketKeys ?? new Set() });
        // Missing markets remain last-known data, never fabricated closed; their check time is not advanced.
        const observation = coverageDocument?.matches?.[match.id];
        const sameIdentity = observation && observation.home === match.home && observation.away === match.away && observation.startTime === match.startTime;
        this.state.coverage[match.id] = coverageFor([...markets.values()], complete && detailsComplete && sameIdentity ? observation.types : null);
        if (detailsComplete) this.state.collectedIds.push(match.id);
        else if (!this.state.failedIds.includes(match.id)) this.state.failedIds.push(match.id);
      }
      this.store.setMeta('activeIds', this.state.activeIds);
      const success = !modeErrors.length && !this.state.failedIds.length && complete;
      this.state.status = success ? 'running' : 'degraded'; this.state.errorCode = modeErrors[0] ?? (this.state.failedIds.length ? 'DETAIL_FAILED' : !complete ? 'PAGINATION_UNKNOWN' : null);
      if (success) { this.state.lastSuccessAt = new Date().toISOString(); this.store.setMeta('lastSuccessAt', this.state.lastSuccessAt); this.failureCount = 0; }
      else this.failureCount++;
    } catch (error) {
      this.state.status = 'blocked'; this.state.errorCode = safeCode(error); this.state.mappingVerified = false; this.state.discoveryComplete = false; this.state.coverage = {}; this.failureCount++;
      this.store.task('cycle', 'failure', this.state.errorCode);
    }
  }
  async captures() {
    try {
      const report = await readJson(process.env.CROWN_CAPTURE_REPORT_PATH ?? resolve('.local/crown/capture-report.json'));
      if (report.mode !== 'historical_capture_inspection' || report.liveVerified !== false || report.fullCoverageVerified !== false) return { available: false };
      return { available: true, ...report };
    } catch { return { available: false }; }
  }
  snapshot(polState, filters = {}) {
    const allMatches = this.store.matches().filter(match => this.state.activeIds.includes(match.id));
    const options = match => ({ collectionHealthy: this.lastDetailState.get(match.id)?.healthy === true && this.state.status !== 'blocked', teamAliases: this.config?.teamAliases, staleMs: this.config ? Math.max(90000, this.config.intervalMs * 3) : 90000 });
    const comparisons = new Map(allMatches.map(match => {
      const keys = this.lastDetailState.get(match.id)?.marketKeys;
      const currentMarkets = this.store.markets(match.id).filter(market => keys?.has(market.key));
      return [match.id, compareMarkets(match, currentMarkets, polState, options(match))];
    }));
    const polCounts = new Map();
    for (const comparison of comparisons.values()) if (comparison.status === 'matched') polCounts.set(comparison.polEventId, (polCounts.get(comparison.polEventId) ?? 0) + 1);
    for (const [id, comparison] of comparisons) if ((polCounts.get(comparison.polEventId) ?? 0) > 1) comparisons.set(id, { status:'ambiguous', reason:'多个皇冠比赛指向同一预测市场事件，需人工核对', markets:[] });
    const matches = allMatches.filter(match => (!filters.matchId || match.id === filters.matchId) && (!filters.source || match.sources.includes(filters.source)));
    return { ...this.state, error: ERRORS[this.state.errorCode] ?? null, readOnly: true, counts: { today: this.state.todayIds.length, early: this.state.earlyIds.length, unique: this.state.activeIds.length, collected: this.state.collectedIds.length, failed: new Set(this.state.failedIds).size },
      matches: matches.map(match => {
        const markets = this.store.markets(match.id).filter(m => !filters.type || m.type === filters.type);
        return { ...match, markets, coverage: this.state.coverage[match.id] ?? coverageFor(markets, null), comparison: { ...comparisons.get(match.id), markets: (comparisons.get(match.id)?.markets ?? []).filter(m => !filters.type || m.type === filters.type) } };
      }), tasks: this.store.tasks(), notice: '覆盖率必须逐场对照新鲜网页证据；报价换算未扣手续费或保证成交，不代表套利。' };
  }
}
