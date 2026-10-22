import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectCapture, summarizeCaptures } from '../src/crown/captures.mjs';
const capture = name => readFile(new URL(`./fixtures/crown/${name}.json`,import.meta.url),'utf8');

test('allowlisted derivatives of actual uploads identify exactly two NBA matches in each list and deduplicate original wrapper copies',async()=>{
 const today=inspectCapture(await capture('today'),'today');const early=inspectCapture(await capture('early'),'early');
 assert.equal(today.nbaRecords,2);assert.equal(early.nbaRecords,2);const report=summarizeCaptures([today,early]);
 assert.equal(report.uniqueMatches,2);assert.deepEqual(new Set(report.uniqueMatchIds),new Set(['10635242','10635305']));
 assert.equal(today.matches[0].timeZoneVerified,false);assert.equal(today.matches[0].teamDirectionVerified,false);assert.equal(report.liveVerified,false);
});
test('the uploaded file called early contradicts its response mode; filenames never prove a real early request',async()=>{
 const early=inspectCapture(await capture('early'),'early');assert.equal(early.responseMode,'today');assert.equal(early.sourceConflict,true);assert.equal(early.sourceVerified,false);assert.equal(early.paginationObserved.pageCount,1);assert.equal(early.paginationObserved.requestPaginationVerified,false);
});
test('thirteen observed detail child GIDs stay in one family rather than becoming thirteen games',async()=>{
 const detail=inspectCapture(await capture('more'),'detail');assert.equal(detail.childRecords,13);assert.equal(detail.families.length,1);const family=detail.families[0];
 assert.equal(family.familyId,'1540749');assert.equal(family.masterCandidates.length,1);assert.equal(family.masterCandidates[0].gid,'10635242');
 assert.deepEqual(family.observedLineValues.spreads,[2.5,3.5,4.5]);assert.deepEqual(family.observedLineValues.totals,[234.5,235.5,236.5]);assert.equal(family.nonzeroMoneylineRecords,1);assert.equal(detail.coverage,'unverified');
});
test('uploaded SW=Y records with blank lines and zero quotes remain placeholders, not available zero-price markets',async()=>{
 const detail=inspectCapture(await capture('more'),'detail');const rows=detail.families[0].observations;
 assert.ok(rows.some(r=>r.rawSwitch==='Y'&&r.line===null&&!r.hasNonzeroQuote));
 assert.ok(rows.every(r=>r.phaseVerified===false&&r.oddsFormatVerified===false&&r.directionVerified===false&&r.availabilityVerified===false));
});
test('a valid embedded original JSON string is reported valid, not declared truncated solely by filename or size',async()=>{
 const derived=JSON.parse(await capture('more'));derived.original_json=JSON.stringify({response:{GAMES:derived.response.GAMES}});
 assert.equal(inspectCapture(JSON.stringify(derived),'detail').embeddedOriginal,'valid_json_string');
 derived.original_json='{"response":';assert.equal(inspectCapture(JSON.stringify(derived),'detail').embeddedOriginal,'invalid_json_string');
});
