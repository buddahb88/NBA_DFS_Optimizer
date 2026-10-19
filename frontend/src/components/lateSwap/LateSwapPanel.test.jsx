import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { buildRequest, filterEntries, outputFileName, splitList } from './lateSwapUtils';

// Plain function, not vi.fn: vitest reports errors thrown inside vi.fn implementations
// even when the component catches them, and the error-path test needs a rejection.
const calls = [];
let respond = () => Promise.resolve({ data: null });
vi.mock('../../services/api', () => ({
  slatesAPI: { getAll: () => Promise.resolve({ data: [{ slate_id: 's1', name: 'Main', site: 'draftkings' }] }) },
  lateSwapAPI: { run: (body) => { calls.push(body); return respond(body); } },
}));

const { default: LateSwapPanel } = await import('./LateSwapPanel');

const player = (name, extra = {}) => ({ siteId: name, name, team: 'MIA', salary: 5000, projection: 30, status: null, ...extra });
const RESULT = {
  site: 'draftkings',
  now: '2026-10-18T00:15:00.000Z',
  summary: { entries: 2, changedEntries: 1, swaps: 1, lockedOut: 1, errors: 0, projectionBefore: 400, projectionAfter: 420 },
  locks: [{ team: 'LAL', startTime: '2026-10-17T23:00:00.000Z', locked: true }, { team: 'MIA', startTime: null, locked: false }],
  warnings: ['No start time for MIA; treated as unlocked.'],
  exposures: [{ siteId: 'B', name: 'Bam', locked: false, before: 0, after: 50 }],
  entries: [
    {
      entryId: '111', contestName: 'NBA Shot', swaps: 1, gain: 20, status: 'changed',
      before: { salary: 49000, projection: 200 }, after: { salary: 49500, projection: 220, remainingSalary: 500 },
      flags: [{ type: 'LOCKED_OUT', message: 'X is OUT but already locked' }],
      slots: [
        { slot: 'PG', locked: false, changed: true, reason: 'out', before: player('Tyler', { status: 'OUT' }), after: player('Bam') },
        { slot: 'SG', locked: true, changed: false, reason: 'locked', before: player('LeBron', { team: 'LAL' }), after: player('LeBron', { team: 'LAL' }) },
      ],
    },
    {
      entryId: '222', contestName: 'NBA Shot', swaps: 0, gain: 0, status: 'unchanged',
      before: { salary: 49000, projection: 200 }, after: { salary: 49000, projection: 200, remainingSalary: 1000 },
      flags: [], slots: [],
    },
  ],
  csv: 'Entry ID,PG\r\n111,B\r\n',
};

describe('late swap helpers', () => {
  it('builds the request body from form state', () => {
    expect(buildRequest({
      slateId: 's1', csv: 'x', mode: 'outOnly', maxExposure: '40', swapQuestionable: true, unique: true,
      outPlayers: 'Tyler Herro, 123\n', lockedTeams: 'lal, bos', now: '',
    })).toEqual({
      slateId: 's1', csv: 'x', mode: 'outOnly', maxExposure: 40, swapQuestionable: true, unique: true,
      outPlayers: ['Tyler Herro', '123'], lockedTeams: ['LAL', 'BOS'],
    });
    expect(buildRequest({ slateId: 's1', csv: 'x', maxExposure: '', now: '2026-10-17T20:15' }).now).toMatch(/^2026-10-1\dT/);
  });

  it('filters entries and names the output file', () => {
    expect(filterEntries(RESULT.entries, 'changed').map((e) => e.entryId)).toEqual(['111']);
    expect(filterEntries(RESULT.entries, 'flagged').map((e) => e.entryId)).toEqual(['111']);
    expect(filterEntries(RESULT.entries, 'all')).toHaveLength(2);
    expect(outputFileName('DKEntries.csv')).toBe('DKEntries-lateswap.csv');
    expect(splitList(' a ,, b ')).toEqual(['a', 'b']);
  });
});

describe('LateSwapPanel', () => {
  beforeEach(() => { calls.length = 0; });

  it('uploads a file, runs late swap and shows the diff', async () => {
    respond = () => Promise.resolve({ data: RESULT });
    render(<LateSwapPanel />);

    const button = screen.getByRole('button', { name: /run late swap/i });
    expect(button).toBeDisabled();

    const file = new File(['Entry ID,PG\n111,1001\n'], 'DKEntries.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText(/entries csv/i), { target: { files: [file] } });
    await waitFor(() => expect(button).toBeEnabled());

    fireEvent.click(button);
    await screen.findByText('Entries changed');
    expect(calls).toEqual([expect.objectContaining({ slateId: 's1', csv: 'Entry ID,PG\n111,1001\n', mode: 'optimize' })]);

    expect(screen.getByText('Locked OUT', { selector: 'span.rounded' })).toBeInTheDocument();
    expect(screen.getByText(/No start time for MIA/)).toBeInTheDocument();
    expect(screen.queryByText('222')).not.toBeInTheDocument(); // 'Changed' filter by default

    fireEvent.click(screen.getByRole('button', { name: /111/ }));
    expect(screen.getByText('Tyler')).toBeInTheDocument();
    expect(screen.getAllByText('Bam').length).toBeGreaterThan(0);
  });

  it('shows the server error message', async () => {
    const err = Object.assign(new Error('Request failed with status code 400'), {
      response: { data: { message: 'Could not find an "Entry ID" header row.' } },
    });
    respond = () => Promise.reject(err);
    render(<LateSwapPanel />);
    fireEvent.change(screen.getByLabelText(/entries csv/i), { target: { files: [new File(['x'], 'bad.csv')] } });
    const button = screen.getByRole('button', { name: /run late swap/i });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('Entry ID');
  });
});
