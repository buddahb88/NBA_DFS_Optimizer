import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ExportLineupsModal from './ExportLineupsModal';
import { lineupsAPI } from '../services/api';

vi.mock('../services/api', () => ({ lineupsAPI: { exportCsv: vi.fn() } }));

describe('ExportLineupsModal', () => {
  beforeEach(() => {
    lineupsAPI.exportCsv.mockReset();
    window.URL.createObjectURL = vi.fn(() => 'blob:x');
    window.URL.revokeObjectURL = vi.fn();
    // jsdom can't follow download links
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  it('exports saved lineups as new lineups and reports the download', async () => {
    lineupsAPI.exportCsv.mockResolvedValue({ data: { success: true, csv: 'PG\r\n1\r\n', rowCount: 2, warnings: [] } });
    render(<ExportLineupsModal open onClose={() => {}} lineupIds={[4, 7]} />);

    fireEvent.change(screen.getByLabelText('Site'), { target: { value: 'fanduel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));

    await screen.findByText(/with 2 lineups/);
    expect(lineupsAPI.exportCsv).toHaveBeenCalledWith({ site: 'fanduel', mode: 'new', lineupIds: [4, 7] });
    expect(window.URL.createObjectURL).toHaveBeenCalled();
  });

  it('sends only ids and slots for optimizer lineups, plus the entries file text', async () => {
    lineupsAPI.exportCsv.mockResolvedValue({ data: { success: true, csv: 'x', rowCount: 1, warnings: ['1 entry left unchanged'] } });
    const lineups = [{ name: 'GPP #1', players: [{ position: 'PG', player: { id: 3, name: 'A', salary: 9000 } }] }];
    render(<ExportLineupsModal open onClose={() => {}} lineups={lineups} />);

    fireEvent.click(screen.getByLabelText(/Fill my entries file/));
    const file = new File(['Entry ID,PG\r\n1,\r\n'], 'DKEntries.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('Entries file'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));

    await screen.findByText(/DKEntries-filled\.csv/);
    expect(screen.getByText('1 entry left unchanged')).toBeInTheDocument();
    expect(lineupsAPI.exportCsv).toHaveBeenCalledWith({
      site: 'draftkings',
      mode: 'entries',
      lineups: [{ name: 'GPP #1', players: [{ id: 3, positionSlot: 'PG' }] }],
      entriesTemplate: 'Entry ID,PG\r\n1,\r\n',
    });
  });

  it('asks for the entries file before calling the API', async () => {
    render(<ExportLineupsModal open onClose={() => {}} lineupIds={[1]} />);
    fireEvent.click(screen.getByLabelText(/Fill my entries file/));
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(await screen.findByText(/Choose your DraftKings entries file/)).toBeInTheDocument();
    expect(lineupsAPI.exportCsv).not.toHaveBeenCalled();
  });

  it('lists per-lineup validation errors from the server', async () => {
    lineupsAPI.exportCsv.mockRejectedValue({
      response: {
        data: {
          success: false,
          warnings: [],
          errors: [{ index: 2, name: 'Cash #2', csvRow: 3, messages: ['Salary $50,400 is over the $50,000 cap'] }],
        },
      },
    });
    render(<ExportLineupsModal open onClose={() => {}} lineupIds={[1, 2]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Cash #2 (CSV row 3): Salary $50,400 is over the $50,000 cap'));
  });
});
