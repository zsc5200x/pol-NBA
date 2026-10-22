import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TEAMS, teamFor, translateTeams, eventTeams, eventTitle, marketTitle, outcomeTitle, errorMessage, timezoneName } from '../public/chinese.js';

test('all thirty NBA teams and aliases map to Chinese without substring collisions', () => {
  assert.equal(TEAMS.length, 30);
  assert.equal(new Set(TEAMS.map(team => team.id)).size, 30);
  for (const team of TEAMS) {
    for (const alias of team.aliases) {
      assert.equal(teamFor(alias.toLowerCase())?.id, team.id);
      assert.equal(translateTeams(alias), team.name);
    }
    assert.equal(teamFor(team.short)?.id, team.id);
  }
  assert.equal(translateTeams('Charlotte Hornets vs. Brooklyn Nets'), '夏洛特黄蜂 vs. 布鲁克林篮网');
  assert.equal(translateTeams('Netscape Heating'), 'Netscape Heating');
});

test('matchups recognize full names, nicknames, Chinese demo names and NBA slug fallback', () => {
  assert.equal(eventTitle({ title: 'Lakers vs. Warriors' }), '洛杉矶湖人 对阵 金州勇士');
  assert.equal(eventTitle({ title: 'Boston Celtics vs. New York Knicks' }), '波士顿凯尔特人 对阵 纽约尼克斯');
  assert.equal(eventTitle({ title: '湖人 vs. 勇士（演示）' }), '洛杉矶湖人 对阵 金州勇士（演示）');
  assert.deepEqual(eventTeams({ title: 'An unknown title', slug: 'nba-atl-orl-2026-10-22' }).map(t => t.id), ['atl', 'orl']);
  assert.equal(eventTitle({ title: 'Unrecognized expansion team' }), '篮球比赛（球队待识别）');
});

test('spread translations preserve the reference team and opposite signed handicap', () => {
  const negative = { type: 'spreads', question: 'Spread: Magic (-2.5)' };
  assert.equal(marketTitle(negative, {}), '奥兰多魔术（-2.5）· 让分');
  assert.equal(outcomeTitle({ name: 'Magic' }, negative), '奥兰多魔术（-2.5）');
  assert.equal(outcomeTitle({ name: 'Hawks' }, negative), '亚特兰大老鹰（+2.5）');
  const positive = { type: 'spreads', question: 'Spread: Los Angeles Lakers (+4.5)' };
  assert.equal(outcomeTitle({ name: 'Lakers' }, positive), '洛杉矶湖人（+4.5）');
  assert.equal(outcomeTitle({ name: 'Warriors' }, positive), '金州勇士（-4.5）');
  const zero = { type: 'spreads', question: 'Spread: Lakers (0)' };
  assert.equal(outcomeTitle({ name: 'Warriors' }, zero), '金州勇士（0）');
});

test('totals translate over/under and retain the exact line without mutating market data', () => {
  const market = { type: 'totals', question: 'Lakers vs. Warriors: O/U 233.5' };
  const original = JSON.stringify(market);
  const event = { title: 'Lakers vs. Warriors' };
  assert.equal(marketTitle(market, event), '洛杉矶湖人 对阵 金州勇士 · 总分 233.5');
  assert.equal(outcomeTitle({ name: 'Over' }, market), '大于 233.5');
  assert.equal(outcomeTitle({ name: 'Under' }, market), '小于 233.5');
  assert.equal(outcomeTitle({ name: 'Under 240.5' }, market), '小于 240.5');
  assert.equal(outcomeTitle({ name: 'Yes' }, market), '是');
  assert.equal(outcomeTitle({ name: 'No' }, market), '否');
  assert.equal(JSON.stringify(market), original);
});

test('unknown English and upstream errors use Chinese fallbacks, timezone names are Chinese', () => {
  assert.equal(outcomeTitle({ name: 'Unknown outcome' }, {}), '其他结果（名称待识别）');
  assert.match(errorMessage('gamma-api.polymarket.com: HTTP 403'), /访问受限/);
  assert.match(errorMessage('request timeout'), /超时/);
  assert.match(errorMessage('ECONNRESET'), /网络连接失败/);
  assert.match(errorMessage('HTTP 429'), /过于频繁/);
  assert.equal(timezoneName('America/New_York'), '美国东部时间');
  assert.equal(errorMessage('连接已中断，等待完整快照校准'), '连接已中断，等待完整快照校准');
});

test('every mapped team has a local self-contained SVG, with no remote or executable content', async () => {
  for (const team of TEAMS) {
    const svg = await readFile(new URL(`../public/logos/${team.id}.svg`, import.meta.url), 'utf8');
    assert.match(svg, /^<svg\s/);
    assert.match(svg, /viewBox=/);
    assert.doesNotMatch(svg, /<script|<foreignObject|\son[a-z]+=|(?:href|src)="https?:/i);
  }
});
