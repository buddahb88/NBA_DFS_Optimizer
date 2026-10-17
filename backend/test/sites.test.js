import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SITES, SITE_KEYS, getSiteConfig, getEligibleSlots, isValidSite } from '../src/config/sites.js';

test('exposes draftkings, fanduel and yahoo', () => {
  assert.deepEqual(SITE_KEYS, ['draftkings', 'fanduel', 'yahoo']);
});

test('salary caps and roster sizes', () => {
  assert.equal(SITES.draftkings.salaryCap, 50000);
  assert.equal(SITES.fanduel.salaryCap, 60000);
  assert.equal(SITES.yahoo.salaryCap, 200);
  assert.deepEqual(SITES.draftkings.rosterSlots.map(s => s.slot), ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL']);
  assert.deepEqual(SITES.fanduel.rosterSlots.map(s => s.slot), ['PG', 'PG', 'SG', 'SG', 'SF', 'SF', 'PF', 'PF', 'C']);
  assert.deepEqual(SITES.yahoo.rosterSlots.map(s => s.slot), ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL']);
  assert.equal(SITES.fanduel.maxPlayersPerTeam, 4);
});

test('csv export columns line up with roster slots', () => {
  for (const site of SITE_KEYS) {
    const { csvExport, rosterSlots } = SITES[site];
    assert.equal(csvExport.header.length, rosterSlots.length, site);
    assert.deepEqual(csvExport.slotOrder, rosterSlots.map(s => s.slot), site);
  }
});

test('getSiteConfig defaults to draftkings, is case-insensitive, rejects unknown', () => {
  assert.equal(getSiteConfig().key, 'draftkings');
  assert.equal(getSiteConfig('FanDuel').key, 'fanduel');
  assert.throws(() => getSiteConfig('superdraft'), /Unknown DFS site/);
  assert.equal(isValidSite('toString'), false);
});

test('configs are frozen', () => {
  assert.throws(() => { getSiteConfig('draftkings').salaryCap = 1; }, TypeError);
  assert.throws(() => { getSiteConfig('yahoo').rosterSlots[0].eligible.push('C'); }, TypeError);
});

test('getEligibleSlots per site', () => {
  assert.deepEqual(getEligibleSlots('draftkings', 'PG,SG'), ['PG', 'SG', 'G', 'UTIL']);
  assert.deepEqual(getEligibleSlots('draftkings', 'C'), ['C', 'UTIL']);
  assert.deepEqual(getEligibleSlots('fanduel', 'SF/PF'), ['SF', 'PF']);
  assert.deepEqual(getEligibleSlots('yahoo', ['PF', 'C']), ['PF', 'F', 'C', 'UTIL']);
  assert.deepEqual(getEligibleSlots('yahoo', ''), []);
});

// Sanity check: DK scoring weights reproduce nbaStatsService's DK formula
test('draftkings scoring matches existing DK fantasy point calc', () => {
  const s = SITES.draftkings.scoring;
  // 20 pts, 10 reb, 10 ast, 2 stl, 1 blk, 3 tov, 2 3PM -> triple-double
  const base = 20 * s.pts + 10 * s.reb + 10 * s.ast + 2 * s.stl + 1 * s.blk + 3 * s.tov + 2 * s.tpm;
  const bonus = s.tripleDouble + (s.bonusesStack ? s.doubleDouble : 0);
  assert.equal(base + bonus, 20 + 12.5 + 15 + 4 + 2 - 1.5 + 1 + 4.5);
});
