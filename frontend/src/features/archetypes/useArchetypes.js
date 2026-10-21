import { useCallback, useEffect, useRef, useState } from 'react';
import { archetypesAPI, historicalAPI } from '../../services/api';
import { defenseParams, errorMessage } from './archetypes';

const IDLE = { status: 'idle', data: null, error: null };
// Keep the previous data while reloading so the grid doesn't flash empty
const loading = (prev) => ({ status: 'loading', data: prev?.data ?? null, error: null });
const ready = (data) => ({ status: 'ready', data, error: null });
const failed = (err) => ({ status: 'error', data: null, error: errorMessage(err) });

/** Run `request` into `setState`, ignoring responses after cleanup. */
function load(request, setState, pick = (d) => d) {
  let cancelled = false;
  setState(loading);
  request().then(
    (res) => !cancelled && setState(ready(pick(res.data))),
    (err) => !cancelled && setState(failed(err)),
  );
  return () => {
    cancelled = true;
  };
}

/**
 * Data for the Archetypes page:
 *   definitions  GET /archetypes/definitions (legend + column order), once
 *   seasons      GET /historical/seasons, once
 *   defense      GET /archetypes/defense for site + season / grouping / lastNGames
 *   tonight      GET /archetypes/tonight for slateId (+ stat), idle without a slate
 *   cell         drill-down for one heatmap cell: openCell({ team, group, label }),
 *                closeCell(); null when closed. Uses the season the grid loaded.
 * Sections are { status: 'idle' | 'loading' | 'ready' | 'error', data, error }.
 * The stat only re-ranks tonight; the heatmap reads it client-side.
 */
export default function useArchetypes({ site, slateId, filters }) {
  const [definitions, setDefinitions] = useState(IDLE);
  const [seasons, setSeasons] = useState(IDLE);
  const [defense, setDefense] = useState(IDLE);
  const [tonight, setTonight] = useState(IDLE);
  const [cell, setCell] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const cellRequest = useRef(0);

  // Serialized so a new-but-equal filters object doesn't refetch
  const paramsJson = JSON.stringify(defenseParams(filters, site));
  const { stat } = filters;

  useEffect(() => load(() => archetypesAPI.getDefinitions(), setDefinitions), []);
  useEffect(() => load(() => historicalAPI.getSeasons(), setSeasons), []);

  useEffect(
    () => load(() => archetypesAPI.getDefense(JSON.parse(paramsJson)), setDefense),
    [paramsJson, reloadToken],
  );

  useEffect(() => {
    if (!slateId) {
      setTonight(IDLE);
      return undefined;
    }
    return load(() => archetypesAPI.getTonight({ ...JSON.parse(paramsJson), slateId, stat }), setTonight);
  }, [paramsJson, slateId, stat, reloadToken]);

  // The season the grid actually shows (Auto may have fallen back to last season)
  const gridSeason = defense.data?.season ?? null;

  const openCell = useCallback(
    ({ team, group, label }) => {
      const id = ++cellRequest.current;
      const base = { team, group, label: label ?? group };
      setCell({ ...base, status: 'loading', data: null, error: null });
      // Only the latest open cell may land
      const settle = (next) => id === cellRequest.current && setCell({ ...base, ...next });
      // Pin the grid's season; the drill-down has no fallback of its own
      const params = JSON.parse(paramsJson);
      delete params.seasonFallback;
      if (gridSeason) params.season = gridSeason;
      archetypesAPI.getCellGames(team, group, params).then(
        (res) => settle(ready(res.data)),
        (err) => settle(failed(err)),
      );
    },
    [paramsJson, gridSeason],
  );

  const closeCell = useCallback(() => {
    cellRequest.current += 1;
    setCell(null);
  }, []);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  return { definitions, seasons, defense, tonight, cell, openCell, closeCell, reload };
}
