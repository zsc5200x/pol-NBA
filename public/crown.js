const panel = document.getElementById('crown-panel');
const status = document.getElementById('crown-status');
const content = document.getElementById('crown-content');
const summary = document.getElementById('crown-summary');
const sourceFilter = document.getElementById('crown-source');
const typeFilter = document.getElementById('crown-type');
const matchFilter = document.getElementById('crown-match');
const labels = { totals:'大小分', spreads:'让分', moneyline:'独赢', over:'大分', under:'小分', home:'主队', away:'客队', open:'开放', closed:'关闭', suspended:'暂停', unknown:'状态未验证', parsed:'已解析', incomplete_odds:'赔率缺失或格式未验证', status_unverified:'状态未验证', conflict:'冲突待核对', verified:'已核对', unverified:'盘口覆盖未验证', mismatch:'网页盘口不一致', matched:'已匹配', unmatched:'未匹配', ambiguous:'匹配不唯一', line_unmatched:'无同线盘口', comparable_quote:'同线报价可比较', stale:'数据过期', unavailable:'不可比较', outcome_unmatched:'方向未匹配' };
const text = v => labels[v] ?? '未验证';
const node = (tag, cls='', value='') => { const n=document.createElement(tag);n.className=cls;n.textContent=value;return n; };
const n = (value, digits=3) => Number.isFinite(value) ? new Intl.NumberFormat('zh-CN',{maximumFractionDigits:digits}).format(value) : '—';
const time = value => value ? new Date(value).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'})+'（北京时间）' : '尚无';
let pending=false, currentMatchIds='';
const histories=new Map();
async function refreshHistory(history,id){
 if(history.dataset.loading||Date.now()-Number(history.dataset.loaded||0)<5000)return;
 history.dataset.loading='true';
 try{
  const response=await fetch(`/api/crown/history?matchId=${encodeURIComponent(id)}`,{signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw Error();const data=await response.json();
  const summary=history.querySelector('summary');history.replaceChildren(summary);
  for(const item of data.history)history.append(node('p','',`${time(item.observedAt)} · ${text(item.type)} ${item.line??''} · ${item.sides.map(s=>`${text(s.direction)} ${s.rawOdds??'缺失'}`).join(' / ')} · ${text(item.status)}`));
  if(!data.history.length)history.append(node('p','','暂无快照'));
  history.dataset.loaded=String(Date.now());
 }catch{if(!history.querySelector('.history-error'))history.append(node('p','history-error','历史读取失败，稍后重试'));}
 finally{delete history.dataset.loading;}
}
async function refresh() {
 if(pending||document.hidden)return;pending=true;
 try {
  const q=new URLSearchParams();if(sourceFilter.value)q.set('source',sourceFilter.value);if(typeFilter.value)q.set('type',typeFilter.value);if(matchFilter.value)q.set('matchId',matchFilter.value);
  const response=await fetch(`/api/crown?${q}`,{signal:AbortSignal.timeout(12000)});if(!response.ok)throw Error();const state=await response.json();
  window.dispatchEvent(new CustomEvent('crown:comparison',{detail:state}));
  status.textContent=({not_configured:'皇冠未配置',starting:'准备中',running:'正在轮询',degraded:'部分采集失败',blocked:'采集受阻'})[state.status]??'未验证';
  summary.textContent=`今日 ${state.counts.today} · 早盘 ${state.counts.early} · 去重 ${state.counts.unique} · 已采集 ${state.counts.collected} · 失败 ${state.counts.failed} ｜ 最后完整成功：${time(state.lastSuccessAt)}`;
  const scrollTop=content.scrollTop;const pageTop=window.scrollY;const pageLeft=window.scrollX;content.replaceChildren();
  if(state.error)content.append(node('p','crown-warning',state.error));
  content.append(node('p','crown-disclaimer',state.notice));
  if(!state.matches.length)content.append(node('p','crown-empty',state.status==='not_configured'?'等待本机安全会话及已核对字段映射；不展示模拟皇冠水位。':'当前筛选没有已保存的皇冠比赛。'));
  if(!matchFilter.value){const ids=state.matches.map(m=>m.id).join(',');if(ids!==currentMatchIds){matchFilter.replaceChildren(new Option('全部比赛',''));for(const m of state.matches)matchFilter.append(new Option(`${m.home} 对 ${m.away}`,m.id));currentMatchIds=ids;}}
  for(const match of state.matches){
   const card=node('article','crown-match-card');
   card.append(node('h3','',`${match.home}（主） 对 ${match.away}（客）`),node('p','crown-meta',`${time(match.startTime)} · ${match.sources.map(s=>s==='today'?'今日':'早盘').join(' / ')} · ${text(match.comparison.status)}${match.comparison.reason?`：${match.comparison.reason}`:''}`));
   const coverage=node('div','crown-coverage');for(const type of ['moneyline','spreads','totals']){const c=match.coverage[type];coverage.append(node('span',c.status==='verified'?'verified':'',`${text(type)}：发现 ${c.discovered} 线 / 已核对 ${c.status==='verified'?c.discovered:0} 线 · ${text(c.status)}`));}card.append(coverage);
   const table=node('div','crown-table');const heading=node('div','crown-row crown-row-heading');for(const title of ['盘口 / 方向','皇冠水位 / 十进制','皇冠隐含概率','预测市场买入 / 卖出','概率差 / 状态'])heading.append(node('span','',title));table.append(heading);
   for(const market of match.markets){const compared=match.comparison.markets.find(m=>m.crownKey===market.key);for(const side of market.sides){const c=compared?.sides.find(s=>s.direction===side.direction);const row=node('div','crown-row');row.append(node('span','',`${text(market.type)} ${side.line??''} · ${text(side.direction)}`),node('span','',`${side.rawOdds??'—'}（${({hongkong:'香港盘',decimal:'十进制',american:'美式'})[side.oddsFormat]??'格式待验证'}） / ${n(side.decimalOdds)}`),node('span','',c?.impliedProbability?`${n(c.impliedProbability*100,2)}%`:'—'),node('span','',`${c?.polAsk!=null?n(c.polAsk*100,2)+'分':'—'} / ${c?.polBid!=null?n(c.polBid*100,2)+'分':'—'}`),node('span','',`${c?.differencePoints!=null?n(c.differencePoints,2)+'百分点 · ':''}${text(c?.comparisonStatus??compared?.status)} · ${text(market.status)} · ${text(market.parseStatus)}`));table.append(row);}table.append(node('small','crown-check-time',`最近成功检查：${time(market.checkedAt)}`));}card.append(table);
   let history=histories.get(match.id);
   if(!history){history=node('details','crown-history');histories.set(match.id,history);history.append(node('summary','','水位变化历史'));history.addEventListener('toggle',()=>{if(history.open)void refreshHistory(history,match.id);});}
   card.append(history);if(history.open)void refreshHistory(history,match.id);content.append(card);
  }
  if(state.tasks.length){const tasks=node('details','crown-history');tasks.append(node('summary','','采集任务记录'));for(const task of state.tasks.slice(0,15))tasks.append(node('p','',`${time(task.observedAt)} · ${task.operation.startsWith('list:')?'比赛发现':task.operation.startsWith('detail:')?'盘口采集':'采集任务'} · ${task.status==='success'?'成功':'失败'}${task.code?'（需检查会话、网络或映射）':''}`));content.append(tasks);}
  content.scrollTop=scrollTop;window.scrollTo(pageLeft,pageTop);requestAnimationFrame(()=>window.scrollTo(pageLeft,pageTop));
 }catch{status.textContent='皇冠监控状态读取失败';content.replaceChildren(node('p','crown-warning','状态读取失败，暂不显示可比较报价；数据库中的历史数据仍保留。'));window.dispatchEvent(new CustomEvent('crown:comparison',{detail:{matches:[]}}));}finally{pending=false;}
}
for(const control of [sourceFilter,typeFilter,matchFilter])control.addEventListener('change',()=>void refresh());
void refresh();setInterval(()=>void refresh(),5000);

const captureReview=document.getElementById('crown-captures');
captureReview.addEventListener('toggle',async()=>{
 if(!captureReview.open)return;
 const target=document.getElementById('crown-capture-content');
 try{
  const response=await fetch('/api/crown/captures',{signal:AbortSignal.timeout(12000)});if(!response.ok)throw Error();const report=await response.json();target.replaceChildren();
  if(!report.available){target.append(node('p','','尚未生成本机样本核对报告。可通过样本检查命令生成，不需要登录凭据。'));return;}
  target.append(node('p','crown-warning',`历史样本合并识别 ${report.uniqueMatches} 场比赛；时区、方向、阶段、赔率格式和完整覆盖尚未验证，不导入实时盘口。`));
  for(const capture of report.captures){
   const part=node('article','crown-match-card');
   if(capture.kind==='list_capture'){
    part.append(node('h3','',capture.reportedSource==='early'?'标为早盘的历史文件':'标为今日的历史文件'));
    part.append(node('p','',`目标比赛 ${capture.nbaRecords} 场 · ${capture.sourceConflict?'内部模式与文件来源冲突':'来源仍待真实请求佐证'}`));
    for(const match of capture.matches)part.append(node('p','',`${match.teamH} / ${match.teamC} · 比赛标识 ${match.gid} · 原始时间 ${match.startTimeRaw}（时区待核验）`));
   }else{
    part.append(node('h3','','附加盘口历史样本'));
    for(const family of capture.families){part.append(node('p','',`${family.childGids.length} 个子记录归于同一比赛家族，未作为独立比赛导入。`));part.append(node('p','',`观察到让分原始线值：${family.observedLineValues.spreads.join('、')}；大小分线值：${family.observedLineValues.totals.join('、')}；非零独赢记录 ${family.nonzeroMoneylineRecords} 组。`));}
   }
   target.append(part);
  }
 }catch{target.textContent='历史样本报告读取失败，请检查本机报告是否已生成。';}
});
