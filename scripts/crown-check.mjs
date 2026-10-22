// Offline validation only. This command never sends HTTP requests or prints session values.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/crown/config.mjs';
import { decode, parseList, parseMarkets, rows, scalar } from '../src/crown/parser.mjs';
import { ERRORS } from '../src/crown/monitor.mjs';
try {
 const filename = process.argv[2] ?? process.env.CROWN_CONFIG_PATH;
 if (!filename) throw { code:'NOT_CONFIGURED' };
 const config = await loadConfig(filename);const report=[];
 for(const mode of ['today','early']) {
  const list=config.lists[mode];const root=decode(await readFile(resolve(config.base,list.evidence.path),'utf8'));
  const parsed=parseList(root,list,mode);
  report.push({source:mode==='today'?'今日':'早盘',operation:'列表脱敏样本',nbaMatches:parsed.matches.length,rejectedRecords:parsed.issues.length,paginationVerified:parsed.paginationVerified});
  if(parsed.issues.length)throw {code:'INVALID_MAPPING'};
  for(const profile of config.details[mode]) {
   const detail=decode(await readFile(resolve(config.base,profile.evidence.path),'utf8'));const ids=new Set();
   for(const rule of profile.markets)for(const row of rows(detail,rule.recordsPath)){const id=scalar(row,rule.matchIdPath);if(id)ids.add(id);}
   let count=0,issues=0;for(const id of ids){const result=parseMarkets(detail,profile,{id},mode);count+=result.markets.length;issues+=result.issues.length;}
   report.push({source:mode==='today'?'今日':'早盘',operation:'详情脱敏样本',fullGameMarkets:count,issues});
   if(issues)throw {code:'INVALID_MAPPING'};
  }
 }
 console.log(JSON.stringify({mode:'offline-capture-check',report,notice:'仅验证本机脱敏样本与配置结构；不代表会话有效、真实请求成功或全盘口覆盖。'},null,2));
} catch(error) { console.error(ERRORS[error.code]??'样本检查失败；未输出捕获内容或任何会话值。'); process.exitCode=1; }
