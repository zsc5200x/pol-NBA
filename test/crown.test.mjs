// All payloads in this file are synthetic contracts, NOT captured Crown responses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decode, parseList, parseMarkets, decimalOdds, coverageFor } from '../src/crown/parser.mjs';
import { loadConfig, loadSession, ENDPOINT } from '../src/crown/config.mjs';
import { CrownStore } from '../src/crown/store.mjs';
import { CrownMonitor } from '../src/crown/monitor.mjs';
import { matchEvent, compareMarkets } from '../src/crown/matching.mjs';

const now = () => new Date().toISOString();
const listProfile = { containerPath:'response', recordsPath:'response.games', fields:{id:'identity',leagueId:'leagueId',league:'league',home:'home',away:'away',startTime:'start',status:'state'}, leagueNames:['NBA 美国职业篮球联赛'], statusValues:{P:'scheduled'}, pagination:{reviewed:true,hasMorePath:'response.more',moreValues:['yes'],endValues:['no'],nextPath:'response.next',requestField:'cursor'} };
const matchRaw = (extra={}) => ({identity:'100',leagueId:'100828',league:'NBA 美国职业篮球联赛',home:'洛杉矶湖人',away:'金州勇士',start:'2026-10-22T19:00:00Z',state:'P',...extra});
const match = (extra={}) => ({id:'100',home:'洛杉矶湖人',away:'金州勇士',startTime:'2026-10-22T19:00:00.000Z',sources:['today'],checkedAt:now(),...extra});
const rules = () => ['totals','spreads','moneyline'].map(type=>({type,recordsPath:`response.${type}`,matchIdPath:'parent',phasePath:'period',fullGameValue:'FT',linePath:'line',lineReference:'away',statusPath:'available',statusValues:{Y:'open',N:'closed',P:'suspended'},oddsFormat:'hongkong',odds:type==='totals'?{over:'first',under:'second'}:{home:'first',away:'second'}}));
const detail = {id:'captured-main',containerPath:'response',params:{filter:'Main',showtype:'today'},markets:rules()};
const payload = () => ({response:{ totals:[{parent:'100',period:'FT',line:'235.5',available:'Y',first:'0.95',second:'0.90'},{parent:'100',period:'HT',line:'110.5',available:'Y',first:'0.9',second:'0.9'},{parent:'other',period:'FT',line:'236.5',available:'Y',first:'0.9',second:'0.9'}],spreads:[{parent:'100',period:'FT',line:'-3.5',available:'Y',first:'0.91',second:'0.99'}],moneyline:[{parent:'100',period:'FT',available:'Y',first:'0.7',second:'1.2'}]}});

async function configFixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'crown-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const capture='synthetic test contract; not a live response';await writeFile(join(dir,'capture.txt'),capture);
 const evidence={path:'capture.txt',sha256:createHash('sha256').update(capture).digest('hex'),reviewedAt:now()};
 const sessionPath=join(dir,'session.json');await writeFile(sessionPath,JSON.stringify({params:{uid:'synthetic-only',ver:'test'},cookie:'synthetic=test'}),{mode:0o600});
 const cfg={endpoint:ENDPOINT,sessionFile:'session.json',intervalMs:10000,requestGapMs:500,lists:{today:{...listProfile,reviewed:true,evidence},early:{...listProfile,reviewed:true,evidence}},details:{today:[{...detail,reviewed:true,evidence}],early:[{...detail,params:{filter:'Main',showtype:'early'},reviewed:true,evidence}]}};
 for(const mode of ['today','early'])for(const [op,p] of [['get_game_list',cfg.lists[mode]],['get_game_more',cfg.details[mode][0]]]){
  const filename=`request-${mode}-${op}.json`;const body=JSON.stringify({endpoint:ENDPOINT,method:'POST',params:{p:op,gtype:'bk',showtype:mode,ltype:'3',...(p.params??{})}});await writeFile(join(dir,filename),body);
  p.requestEvidence={path:filename,sha256:createHash('sha256').update(body).digest('hex'),reviewedAt:now()};
 }
 const path=join(dir,'config.json');await writeFile(path,JSON.stringify(cfg));return {dir,path,cfg,sessionPath};
}

test('synthetic JSON/XML decoding preserves identifiers and blocks HTML/DTD, empty and malformed data',()=>{
 assert.equal(decode('{"id":"00100"}').id,'00100');assert.equal(decode('<response><id>00100</id></response>').response.id,'00100');
 for(const body of ['', '<html>login</html>','<!DOCTYPE x><x/>','{bad','<response>'])assert.throws(()=>decode(body));
});
test('NBA league ID and name must both match; repeated rows deduplicate without creating child games',()=>{
 const root={response:{more:'no',games:[matchRaw(),matchRaw(),matchRaw({identity:'2',leagueId:'2'}),matchRaw({identity:'3',league:'其他联赛'})]}};
 const result=parseList(root,listProfile,'today');assert.equal(result.matches.length,1);assert.deepEqual(result.matches[0].sources,['today']);assert.equal(result.paginationVerified,true);
 const child=parseList({response:{more:'no',games:[matchRaw({parent:'other'})]}},{...listProfile,parentIdPath:'parent'},'early');assert.equal(child.matches.length,0);
});
test('missing and ambiguous times never become a falsely matched NBA game; unknown pagination remains unverified',()=>{
 const data={response:{games:[matchRaw({start:'2026-10-22 19:00'}),matchRaw({identity:'',start:'2026-10-22T19:00:00Z'})]}};
 const r=parseList(data,{...listProfile,pagination:null},'today');assert.equal(r.matches.length,0);assert.equal(r.issues.length,2);assert.equal(r.paginationVerified,false);
 assert.throws(()=>parseList({response:{more:'yes',games:[]}},listProfile,'today'),/PAGINATION_UNKNOWN/);
});
test('full-game parent gating excludes half-game and unrelated subrecords; away-reference spread sign converts to home',()=>{
 const r=parseMarkets(payload(),detail,match(),'today');assert.equal(r.markets.length,3);
 const spread=r.markets.find(m=>m.type==='spreads');assert.equal(spread.line,3.5);assert.equal(spread.sides.find(s=>s.direction==='away').line,-3.5);
 assert.equal(spread.sides[0].rawOdds,'0.91');assert.ok(Math.abs(spread.sides[0].decimalOdds-1.91)<1e-12);
 assert.equal(r.markets.find(m=>m.type==='totals').line,235.5);
});
test('missing odds remain null; reviewed closed/suspended states are distinct from unknown states',()=>{
 const p=payload();p.response.totals[0].first='';p.response.spreads[0].available='N';p.response.moneyline[0].available='P';
 const r=parseMarkets(p,detail,match(),'today').markets;assert.equal(r[0].sides[0].decimalOdds,null);assert.equal(r[0].parseStatus,'incomplete_odds');assert.equal(r[1].status,'closed');assert.equal(r[2].status,'suspended');
 p.response.spreads[0].available='SW_UNKNOWN';assert.equal(parseMarkets(p,detail,match(),'today').markets[1].status,'unknown');
});
test('duplicate market records retain one identity and contradictory odds are marked conflict',()=>{
 const p=payload();p.response.totals.push({...p.response.totals[0]});assert.equal(parseMarkets(p,detail,match(),'today').markets.length,3);
 p.response.totals.push({...p.response.totals[0],first:'1.01'});assert.equal(parseMarkets(p,detail,match(),'today').markets[0].parseStatus,'conflict');
});
test('odds conversion requires a declared format and never invents zero or unsupported Malaysian odds',()=>{
 assert.equal(decimalOdds('0.95','hongkong'),1.95);assert.equal(decimalOdds('1.95','decimal'),1.95);assert.equal(decimalOdds('-200','american'),1.5);
 for(const v of [null,'',0,'bad'])assert.equal(decimalOdds(v,'hongkong'),null);assert.equal(decimalOdds('-0.9','malay'),null);assert.equal(decimalOdds('0.95','unknown'),null);
});
test('coverage requires fresh per-type website line evidence; absent, stale, different and incomplete snapshots never verify',()=>{
 const markets=parseMarkets(payload(),detail,match(),'today').markets;
 assert.equal(coverageFor(markets,null).totals.status,'unverified');
 const e={totals:{observedAt:now(),lines:['235.5']},spreads:{observedAt:now(),lines:['3.5']},moneyline:{observedAt:now(),lines:['moneyline']}};
 assert.equal(coverageFor(markets,e).totals.status,'verified');e.totals.lines=['234.5'];assert.equal(coverageFor(markets,e).totals.status,'mismatch');e.totals.observedAt='2000-01-01T00:00:00Z';assert.equal(coverageFor(markets,e).totals.status,'unverified');
});
test('automatic event matching ignores array order but requires unique team pair AND close start time',()=>{
 const events=[{id:'pol',title:'Warriors vs. Lakers',startTime:match().startTime,markets:[]}];assert.equal(matchEvent(match(),events).event.id,'pol');
 assert.equal(matchEvent(match(),[...events,{...events[0],id:'duplicate'}]).status,'ambiguous');
 assert.equal(matchEvent(match({startTime:'2026-10-23T19:00:00Z'}),events).status,'unmatched');
});
test('comparison matches exact full-game line and team direction, uses executable ask, rejects stale/demo data',()=>{
 const markets=parseMarkets(payload(),detail,match(),'today').markets;
 const state={mode:'live',events:[{id:'p',title:'Warriors vs. Lakers',startTime:match().startTime,markets:[{id:'spread',type:'spreads',question:'Spread: Warriors (-3.5)',outcomes:[{name:'Warriors',tokenId:'w'},{name:'Lakers',tokenId:'l'}]}]}],books:{l:{source:'live',asks:[{price:0.52}],bids:[{price:0.50}],verifiedAt:now()},w:{source:'live',asks:[{price:0.49}],bids:[{price:0.47}],verifiedAt:now()}}};
 const spread=compareMarkets(match(),markets,state).markets.find(m=>m.type==='spreads');assert.equal(spread.status,'matched');assert.equal(spread.sides[0].polTokenId,'l');assert.equal(spread.sides[1].polTokenId,'w');assert.equal(spread.sides[0].polAsk,0.52);
 assert.equal(compareMarkets(match(),markets,{...state,mode:'demo'}).status,'unmatched');state.books.l.verifiedAt='2000-01-01T00:00:00Z';assert.equal(compareMarkets(match(),markets,state).markets[1].sides[0].differencePoints,null);
 state.events[0].markets[0].question='Spread: Warriors (-4.5)';assert.equal(compareMarkets(match(),markets,state).markets[1].status,'line_unmatched');
});
test('SQLite unique current state, change-only history, check timestamps and persistence recover correctly',t=>{
 const store=new CrownStore();t.after(()=>store.close());store.upsertMatch(match());
 const m=parseMarkets(payload(),detail,match(),'today').markets[0];store.saveMarket(m);store.saveMarket({...m,checkedAt:new Date(Date.parse(m.checkedAt)+1000).toISOString()});assert.equal(store.history('100').length,1);assert.equal(store.markets('100').length,1);
 const changed=structuredClone(m);changed.sides[0].rawOdds='1.01';changed.checkedAt=new Date(Date.parse(m.checkedAt)+2000).toISOString();store.saveMarket(changed);assert.equal(store.history('100').length,2);assert.equal(store.markets('100')[0].sides[0].rawOdds,'1.01');
});
test('configuration refuses unreviewed or changed capture mappings and broad session file permissions',async t=>{
 const f=await configFixture(t);assert.equal((await loadConfig(f.path)).lists.today.reviewed,true);await loadSession(f.sessionPath);
 f.cfg.lists.today.reviewed=false;await writeFile(f.path,JSON.stringify(f.cfg));await assert.rejects(loadConfig(f.path),/MAPPING_UNVERIFIED/);
 f.cfg.lists.today.reviewed=true;await writeFile(f.path,JSON.stringify(f.cfg));await writeFile(join(f.dir,'capture.txt'),'changed');await assert.rejects(loadConfig(f.path),/EVIDENCE_CHANGED/);
 if(process.platform!=='win32'){const {chmod}=await import('node:fs/promises');await chmod(f.sessionPath,0o644);await assert.rejects(loadSession(f.sessionPath),/SESSION_PERMISSIONS/);}
});
test('collector merges today/early once, persists all full-game markets, but never claims coverage without website evidence',async t=>{
 const f=await configFixture(t);const calls=[];
 const fake={request:async(mode,profile,args)=>{calls.push([mode,profile.id,args.gid]);return JSON.stringify(args.gid?payload():{response:{more:'no',games:[matchRaw(),matchRaw()]}});},cancel(){}};
 const monitor=new CrownMonitor({configPath:f.path,store:new CrownStore(),clientFactory:()=>fake});monitor.running=true;t.after(()=>monitor.stop());await monitor.cycle();
 const s=monitor.snapshot({mode:'live',events:[],books:{}});assert.equal(s.counts.today,1);assert.equal(s.counts.early,1);assert.equal(s.counts.unique,1);assert.equal(s.matches.length,1);assert.deepEqual(s.matches[0].sources,['today','early']);assert.equal(s.matches[0].markets.length,3);assert.equal(s.matches[0].coverage.totals.status,'unverified');assert.equal(s.status,'running');
 assert.equal(calls.length,4);assert.ok(!JSON.stringify(s).includes('synthetic-only'));assert.ok(!JSON.stringify(s).includes('synthetic=test'));
});
test('network/denial failures create task errors and cannot refresh old market check times or fake closed odds',async t=>{
 const f=await configFixture(t);const {CrownError}=await import('../src/crown/parser.mjs');const store=new CrownStore();store.upsertMatch(match());const saved=parseMarkets(payload(),detail,match(),'today').markets[0];store.saveMarket(saved);store.setMeta('activeIds',['100']);
 const monitor=new CrownMonitor({configPath:f.path,store,clientFactory:()=>({request:async()=>{throw new CrownError('ACCESS_OR_SESSION_DENIED');},cancel(){}})});monitor.running=true;t.after(()=>monitor.stop());await monitor.cycle();
 const s=monitor.snapshot({mode:'live',events:[],books:{}});assert.equal(s.status,'degraded');assert.equal(s.errorCode,'ACCESS_OR_SESSION_DENIED');assert.equal(s.lastSuccessAt,null);assert.equal(store.markets('100')[0].checkedAt,saved.checkedAt);assert.equal(store.markets('100')[0].status,'open');assert.ok(store.tasks().some(task=>task.status==='failure'));
});
test('family relation maps several child GIDs to the main GID without weakening full-game gating',()=>{
 const p=payload();for(const type of ['totals','spreads','moneyline'])for(const row of p.response[type])if(row.parent==='100')row.parent='fam-100';
 const profile={...detail,markets:rules().map(rule=>({...rule,matchReference:'familyId'}))};
 const result=parseMarkets(p,profile,match({familyId:'fam-100'}),'today');assert.equal(result.markets.length,3);assert.ok(result.markets.every(m=>m.matchId==='100'));assert.equal(result.markets.filter(m=>m.type==='totals').length,1);
});
test('a configured response source check blocks today-labelled data from being accepted as early',()=>{
 assert.throws(()=>parseList({phpData:{NOWSHOWTYPE:'today'},response:{more:'no',games:[matchRaw()]}},{...listProfile,sourceModePath:'phpData.NOWSHOWTYPE'},'early'),/SOURCE_MODE_CONFLICT/);
});
test('explicit source timezone converts unzoned timestamps without assuming local timezone or accepting DST folds',async()=>{
 const {parseStartTime}=await import('../src/crown/parser.mjs');
 assert.equal(parseStartTime('2026-10-22 19:00:00',null),null);
 assert.equal(parseStartTime('2026-10-22 19:00:00','America/New_York'),'2026-10-22T23:00:00.000Z');
 assert.equal(parseStartTime('2026-01-22 19:00:00','America/New_York'),'2026-01-23T00:00:00.000Z');
 assert.equal(parseStartTime('2026-11-01 01:30:00','America/New_York'),null);
 assert.equal(parseStartTime('2026-03-08 02:30:00','America/New_York'),null);
});
test('SQLite file recovers current state, history and last successful metadata after close/reopen',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crown-db-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'db.sqlite');
 const first=new CrownStore(path);first.upsertMatch(match());first.saveMarket(parseMarkets(payload(),detail,match(),'today').markets[0]);first.setMeta('lastSuccessAt','2026-10-22T00:00:00Z');first.close();
 const reopened=new CrownStore(path);t.after(()=>reopened.close());assert.equal(reopened.matches().length,1);assert.equal(reopened.history('100').length,1);assert.equal(reopened.meta('lastSuccessAt'),'2026-10-22T00:00:00Z');
});
test('a failed cycle resumes after configuration/session repair without overlapping work',async t=>{
 const f=await configFixture(t);let fail=true;const {CrownError}=await import('../src/crown/parser.mjs');const monitor=new CrownMonitor({configPath:f.path,store:new CrownStore(),clientFactory:()=>({request:async(mode,p,args)=>{if(fail)throw new CrownError('SESSION_EXPIRED');return JSON.stringify(args.gid?payload():{response:{more:'no',games:[matchRaw()]}});},cancel(){}})});monitor.running=true;t.after(()=>monitor.stop());
 await monitor.cycle();assert.equal(monitor.state.errorCode,'SESSION_EXPIRED');assert.equal(monitor.state.lastSuccessAt,null);
 fail=false;await monitor.cycle();assert.equal(monitor.state.status,'running');assert.equal(monitor.state.collectedIds.length,1);assert.ok(monitor.state.lastSuccessAt);
});
test('two Crown match IDs pointing at the same Polymarket event remain ambiguous even after UI match filtering',t=>{
 const store=new CrownStore();const monitor=new CrownMonitor({store});t.after(()=>monitor.stop());store.upsertMatch(match());store.upsertMatch(match({id:'other-id'}));monitor.state.activeIds=['100','other-id'];
 const pol={mode:'live',events:[{id:'one-event',title:'Lakers vs. Warriors',startTime:match().startTime,markets:[]}],books:{}};
 const result=monitor.snapshot(pol,{matchId:'100'});assert.equal(result.matches.length,1);assert.equal(result.matches[0].comparison.status,'ambiguous');assert.deepEqual(result.matches[0].comparison.markets,[]);
});
test('an invented detail filter is rejected even when it points at an otherwise reviewed response sample',async t=>{
 const f=await configFixture(t);f.cfg.details.today[0].params.filter='UNVERIFIED_CATEGORY';await writeFile(f.path,JSON.stringify(f.cfg));await assert.rejects(loadConfig(f.path),/REQUEST_UNVERIFIED/);
});
test('non-finite scheduler values are rejected instead of overflowing timers into rapid requests',async t=>{
 const f=await configFixture(t);f.cfg.intervalMs='Infinity';await writeFile(f.path,JSON.stringify(f.cfg));await assert.rejects(loadConfig(f.path),/INVALID_CONFIG/);
});

function comparisonState() {
 const outcomes=[{name:'Lakers',tokenId:'l'},{name:'Warriors',tokenId:'w'}];
 return {mode:'live',events:[{id:'pol',title:'Lakers vs. Warriors',startTime:match().startTime,markets:[
  ...[-3.5,3.5].map(line=>({id:`spread:${line}`,type:'spreads',question:`Spread: Lakers (${line})`,outcomes})),
  {id:'total',type:'totals',question:'Lakers vs. Warriors: O/U 235.5',outcomes:[{name:'Over',tokenId:'o'},{name:'Under',tokenId:'u'}]},
  {id:'winner',type:'moneyline',outcomes},
 ]}],books:Object.fromEntries(['l','w','o','u'].map(id=>[id,{source:'live',asks:[{price:0.5}],bids:[{price:0.49}],verifiedAt:now()}]))};
}
const currentComparison = monitor => monitor.snapshot(comparisonState()).matches[0]?.comparison.markets ?? [];
const hasValidQuote = markets => markets.some(market=>market.sides.some(side=>side.comparisonStatus==='comparable_quote'));

test('a pending new detail poll keeps the previous fresh quotes while collected progress resets',async t=>{
 const f=await configFixture(t);let pause=false,release,started;
 const gate=new Promise(resolve=>{release=resolve;});const entered=new Promise(resolve=>{started=resolve;});
 const fake={request:async(mode,profile,args)=>{if(args.gid&&pause){pause=false;started();await gate;}return JSON.stringify(args.gid?payload():{response:{more:'no',games:[matchRaw()]}});},cancel(){release();}};
 const monitor=new CrownMonitor({configPath:f.path,store:new CrownStore(),clientFactory:()=>fake});monitor.running=true;t.after(()=>monitor.stop());
 await monitor.cycle();assert.equal(hasValidQuote(currentComparison(monitor)),true);
 pause=true;const pending=monitor.cycle();await entered;
 try {assert.equal(monitor.state.collectedIds.length,0);assert.equal(hasValidQuote(currentComparison(monitor)),true);} finally {release();await pending;}
 assert.equal(monitor.state.collectedIds.length,1);assert.equal(hasValidQuote(currentComparison(monitor)),true);
});

test('a successful new response removes absent quote keys immediately without deleting history',async t=>{
 const f=await configFixture(t);let response=payload();
 const fake={request:async(mode,profile,args)=>JSON.stringify(args.gid?response:{response:{more:'no',games:[matchRaw()]}}),cancel(){}};
 const store=new CrownStore();const monitor=new CrownMonitor({configPath:f.path,store,clientFactory:()=>fake});monitor.running=true;t.after(()=>monitor.stop());
 await monitor.cycle();const total=store.markets('100').find(market=>market.type==='totals');
 assert.ok(currentComparison(monitor).some(market=>market.type==='totals'));
 response=payload();response.response.totals=[];await monitor.cycle();
 assert.equal(currentComparison(monitor).some(market=>market.type==='totals'),false);
 assert.equal(store.markets('100').find(market=>market.key===total.key).checkedAt,total.checkedAt);
 assert.ok(store.history('100').some(market=>market.key===total.key));
 response={response:{totals:[],spreads:[],moneyline:[]}};await monitor.cycle();
 assert.deepEqual(currentComparison(monitor),[]);assert.equal(store.markets('100').length,3);assert.ok(store.history('100').length>=3);
});

test('a spread direction change cannot leave both the previous and new signed lines comparable',async t=>{
 const f=await configFixture(t);let response=payload();
 const fake={request:async(mode,profile,args)=>JSON.stringify(args.gid?response:{response:{more:'no',games:[matchRaw()]}}),cancel(){}};
 const store=new CrownStore();const monitor=new CrownMonitor({configPath:f.path,store,clientFactory:()=>fake});monitor.running=true;t.after(()=>monitor.stop());
 await monitor.cycle();assert.deepEqual(currentComparison(monitor).filter(m=>m.type==='spreads').map(m=>m.line),[3.5]);
 response=payload();response.response.spreads[0].line='3.5';await monitor.cycle();
 const spreads=currentComparison(monitor).filter(m=>m.type==='spreads');assert.deepEqual(spreads.map(m=>m.line),[-3.5]);assert.equal(hasValidQuote(spreads),true);
 assert.deepEqual(store.markets('100').filter(m=>m.type==='spreads').map(m=>m.line).sort((a,b)=>a-b),[-3.5,3.5]);
 assert.ok(store.history('100').some(m=>m.type==='spreads'&&m.line===3.5));
});

test('a failed detail profile disables previous quotes until every required profile succeeds again',async t=>{
 const f=await configFixture(t);const {CrownError}=await import('../src/crown/parser.mjs');let fail=false;
 const fake={request:async(mode,profile,args)=>{if(args.gid&&mode==='early'&&fail)throw new CrownError('ACCESS_OR_SESSION_DENIED');return JSON.stringify(args.gid?payload():{response:{more:'no',games:[matchRaw()]}});},cancel(){}};
 const monitor=new CrownMonitor({configPath:f.path,store:new CrownStore(),clientFactory:()=>fake});monitor.running=true;t.after(()=>monitor.stop());
 await monitor.cycle();assert.equal(hasValidQuote(currentComparison(monitor)),true);
 fail=true;await monitor.cycle();assert.equal(hasValidQuote(currentComparison(monitor)),false);assert.equal(monitor.state.collectedIds.length,0);
 fail=false;await monitor.cycle();assert.equal(hasValidQuote(currentComparison(monitor)),true);
 monitor.state.status='blocked';assert.equal(hasValidQuote(currentComparison(monitor)),false);
});

test('list failures and conflicting identities disable old quotes retained for historical inspection',async t=>{
 const f=await configFixture(t);const {CrownError}=await import('../src/crown/parser.mjs');let mode='success';
 const fake={request:async(source,profile,args)=>{
  if(!args.gid&&mode==='failure')throw new CrownError('ACCESS_OR_SESSION_DENIED');
  const games=mode==='conflict'?[matchRaw(),matchRaw({home:'丹佛掘金'})]:[matchRaw()];
  return JSON.stringify(args.gid?payload():{response:{more:'no',games}});
 },cancel(){}};
 const store=new CrownStore();const monitor=new CrownMonitor({configPath:f.path,store,clientFactory:()=>fake});monitor.running=true;t.after(()=>monitor.stop());
 await monitor.cycle();assert.equal(hasValidQuote(currentComparison(monitor)),true);
 mode='failure';await monitor.cycle();assert.equal(hasValidQuote(currentComparison(monitor)),false);assert.equal(store.markets('100').length,3);
 mode='success';await monitor.cycle();assert.equal(hasValidQuote(currentComparison(monitor)),true);
 mode='conflict';await monitor.cycle();assert.equal(hasValidQuote(currentComparison(monitor)),false);assert.ok(monitor.state.failedIds.includes('100'));
});

test('a new monitor does not treat persisted quotes as validated before a new collection',t=>{
 const store=new CrownStore();store.upsertMatch(match());for(const market of parseMarkets(payload(),detail,match(),'today').markets)store.saveMarket(market);store.setMeta('activeIds',['100']);
 const monitor=new CrownMonitor({store});t.after(()=>monitor.stop());
 assert.deepEqual(currentComparison(monitor),[]);assert.equal(store.markets('100').length,3);assert.equal(store.history('100').length,3);
});
