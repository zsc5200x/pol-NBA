// Structural observations from user-provided captures. This never approves semantics or emits live markets.
import { decode } from './parser.mjs';

const number = value => value != null && String(value).trim() !== '' && /^[+-]?\d+(?:\.\d+)?$/.test(String(value).trim()) ? Number(value) : null;
const nba = record => String(record.LID ?? record.LEAGUE_ID) === '100828' && String(record.LEAGUE ?? '').replace(/\s/g,'') === 'NBA美国职业篮球联赛';
function gameObservation(record) {
  return { gid:String(record.GID??''),familyId:String(record.GIDM??''),teamH:String(record.TEAM_H??''),teamC:String(record.TEAM_C??''),startTimeRaw:record.GAME_DATE_TIME??record.DATETIME??null,
    timeZoneVerified:false,teamDirectionVerified:false };
}
function rawPlays(record, kind) {
  const plays=record.PLAYS ?? Object.assign({},...Object.entries(record).filter(([key])=>/^PLAY\d+$/.test(key)).map(([,value])=>value));
  const play=plays[kind];if(!play)return null;
  const line=kind==='R'?number(play.RATIO_R):kind==='OU'?number(play.RATIO_OUO):null;
  const fields=kind==='R'?['IOR_RH','IOR_RC']:kind==='OU'?['IOR_OUH','IOR_OUC']:['IOR_MH','IOR_MC'];
  const rawOdds=Object.fromEntries(fields.map(field=>[field,number(play[field])===null?null:String(play[field])]));
  return { childGid:String(record.GID??''),kind,line,underLine:kind==='OU'?number(play.RATIO_OUU):null,rawOdds,strong:record.STRONG??play.STRONG??null,
    rawSwitch:play[`SW_${kind}`]??null,rawGameOpen:record.GOPEN??null,rawMaster:record.IS_MASTER??null,rawRelation:record.MS??null,
    hasNonzeroQuote:Object.values(rawOdds).some(value=>number(value)!==null&&number(value)!==0),phaseVerified:false,directionVerified:false,oddsFormatVerified:false,availabilityVerified:false };
}
export function inspectCapture(body, reportedSource) {
  const root=decode(body);if(!root.response||typeof root.response!=='object')throw new Error('CAPTURE_STRUCTURE_UNKNOWN');
  let embedded='absent';
  if(typeof root.original_json==='string'){try{JSON.parse(root.original_json);embedded='valid_json_string';}catch{embedded='invalid_json_string';}}
  else if(root.original_json&&typeof root.original_json==='object')embedded='object';
  if(root.response.GAMES){
    const groups=new Map();let childRecords=0;
    for(const record of Object.values(root.response.GAMES)){
      if(!record||typeof record!=='object'||!nba(record))continue;childRecords++;
      const key=String(record.GIDM??'');if(!key)continue;
      if(!groups.has(key))groups.set(key,{familyId:key,childGids:[],masterCandidates:[],observations:[]});
      const group=groups.get(key);group.childGids.push(String(record.GID??''));
      if(record.IS_MASTER==='Y')group.masterCandidates.push(gameObservation(record));
      for(const kind of ['R','OU','M']){const observation=rawPlays(record,kind);if(observation)group.observations.push(observation);}
    }
    return {kind:'detail_capture',reportedSource,outerJson:'valid',embeddedOriginal:embedded,filter:root.phpData?.filter??null,coverage:'unverified',childRecords,
      families:[...groups.values()].map(group=>({...group,observedLineValues:{spreads:[...new Set(group.observations.filter(o=>o.kind==='R'&&o.line!==null&&o.hasNonzeroQuote).map(o=>o.line))].sort((a,b)=>a-b),totals:[...new Set(group.observations.filter(o=>o.kind==='OU'&&o.line!==null&&o.hasNonzeroQuote).map(o=>o.line))].sort((a,b)=>a-b)},nonzeroMoneylineRecords:group.observations.filter(o=>o.kind==='M'&&o.hasNonzeroQuote).length})),
      notice:'只观察同一 GIDM 的记录关系；不把子记录当新比赛，不据此认定全场、主客方向、盘口开放或覆盖完整。'};
  }
  const records=Object.entries(root.response).filter(([key])=>/^GAME_\d+$/.test(key)).map(([,record])=>record);
  const selected=records.filter(nba);const games=new Map();
  for(const record of selected)if(record.GID)games.set(String(record.GID),{...gameObservation(record),observations:['R','OU','M'].map(kind=>rawPlays(record,kind)).filter(Boolean)});
  const mode=root.phpData?.NOWSHOWTYPE??null;
  return {kind:'list_capture',reportedSource,responseMode:mode,sourceVerified:false,sourceConflict:mode!==null&&mode!==reportedSource,outerJson:'valid',embeddedOriginal:embedded,
    totalRecords:records.length,paginationObserved:{totalDataCount:root.phpData?.TOTALDATACOUNT??null,pageCount:root.phpData?.PAGECOUNT??null,requestPaginationVerified:false},nbaRecords:selected.length,matches:[...games.values()],coverage:'unverified',
    notice:'历史文件名不是实际请求 showtype 的证据；未确认时区和字段语义，不写入实时比赛或盘口表。'};
}
export function summarizeCaptures(observations) {
  const lists=observations.filter(o=>o.kind==='list_capture');const ids=[...new Set(lists.flatMap(o=>o.matches.map(m=>m.gid)))];
  return {mode:'historical_capture_inspection',uniqueMatchIds:ids,uniqueMatches:ids.length,captures:observations,liveVerified:false,fullCoverageVerified:false};
}
