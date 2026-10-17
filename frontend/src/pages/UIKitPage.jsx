import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  IconBolt,
  IconSearch,
  Input,
  Modal,
  Select,
  Slider,
  Spinner,
  Stat,
  Tabs,
  Toggle,
  Tooltip,
} from '../components/ui';

// Static demo data — this page is a dev showcase and makes no API calls.
const PLAYERS = [
  { id: 1, name: 'Nikola Jokic', team: 'DEN', pos: 'C', salary: 11800, proj: 61.4, own: 34.2, ceil: 78.9 },
  { id: 2, name: 'Luka Doncic', team: 'LAL', pos: 'PG/SG', salary: 11200, proj: 57.8, own: 28.9, ceil: 76.1 },
  { id: 3, name: 'Shai Gilgeous-Alexander', team: 'OKC', pos: 'PG', salary: 10600, proj: 53.1, own: 22.4, ceil: 68.0 },
  { id: 4, name: 'Victor Wembanyama', team: 'SAS', pos: 'C', salary: 10400, proj: 52.6, own: 18.1, ceil: 72.3 },
  { id: 5, name: 'Tyrese Maxey', team: 'PHI', pos: 'PG', salary: 8600, proj: 43.0, own: 12.7, ceil: 58.4 },
  { id: 6, name: 'Jalen Williams', team: 'OKC', pos: 'SF', salary: 7400, proj: 36.2, own: 9.3, ceil: 49.5 },
  { id: 7, name: 'Alperen Sengun', team: 'HOU', pos: 'C', salary: 8900, proj: 44.7, own: 15.6, ceil: 59.8 },
  { id: 8, name: 'Derrick White', team: 'BOS', pos: 'PG/SG', salary: 6200, proj: 31.4, own: 6.1, ceil: 44.0 },
  { id: 9, name: 'Naz Reid', team: 'MIN', pos: 'PF/C', salary: 5100, proj: 27.9, own: 21.5, ceil: 41.2 },
  { id: 10, name: 'Keyonte George', team: 'UTA', pos: 'PG', salary: 4500, proj: 23.8, own: 3.4, ceil: 37.6 },
  { id: 11, name: 'Bennedict Mathurin', team: 'IND', pos: 'SG/SF', salary: 5600, proj: 26.0, own: 8.8, ceil: 39.1 },
  { id: 12, name: 'Ausar Thompson', team: 'DET', pos: 'SF', salary: 4800, proj: 25.2, own: 11.0, ceil: 38.7 },
];

const fmtSalary = (v) => `$${v.toLocaleString()}`;
const value = (p) => (p.proj / p.salary) * 1000;
// Leverage: projected optimal rate proxy vs field ownership.
const leverage = (p) => p.ceil / 2 - p.own;

function ValueCell({ v }) {
  const tone = v >= 5.5 ? 'text-positive' : v < 4.8 ? 'text-negative' : 'text-fg';
  return <span className={tone}>{v.toFixed(2)}x</span>;
}

function OwnCell({ v }) {
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      <span className="h-1 w-10 overflow-hidden rounded-full bg-surface-sunken">
        <span className={v >= 25 ? 'block h-full bg-caution' : 'block h-full bg-info'} style={{ width: `${Math.min(v * 2, 100)}%` }} />
      </span>
      {v.toFixed(1)}%
    </span>
  );
}

function LeverageCell({ v }) {
  return <span className={v > 0 ? 'text-positive' : 'text-negative'}>{v > 0 ? '+' : ''}{v.toFixed(1)}</span>;
}

function Section({ title, description, children }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {description && <p className="text-xs text-fg-muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export default function UIKitPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [exposure, setExposure] = useState(40);
  const [uniques, setUniques] = useState(3);
  const [lateSwap, setLateSwap] = useState(true);
  const [stacks, setStacks] = useState(false);
  const [density, setDensity] = useState('compact');
  const [search, setSearch] = useState('');
  const [pos, setPos] = useState('ALL');
  const [loading, setLoading] = useState(false);

  const columns = useMemo(
    () => [
      { accessorKey: 'name', header: 'Player', enableHiding: false, meta: { className: 'font-medium' } },
      { accessorKey: 'pos', header: 'Pos', cell: (c) => <Badge size="sm">{c.getValue()}</Badge> },
      { accessorKey: 'team', header: 'Team', meta: { className: 'text-fg-muted' } },
      { accessorKey: 'salary', header: 'Salary', meta: { numeric: true }, cell: (c) => fmtSalary(c.getValue()) },
      { accessorKey: 'proj', header: 'Proj', meta: { numeric: true, className: 'font-semibold' }, cell: (c) => c.getValue().toFixed(1) },
      { id: 'value', accessorFn: value, header: 'Value', meta: { numeric: true }, cell: (c) => <ValueCell v={c.getValue()} /> },
      { accessorKey: 'own', header: 'Own%', meta: { numeric: true }, cell: (c) => <OwnCell v={c.getValue()} /> },
      { accessorKey: 'ceil', header: 'Ceiling', meta: { numeric: true }, cell: (c) => c.getValue().toFixed(1) },
      { id: 'lev', accessorFn: leverage, header: 'Leverage', meta: { numeric: true }, cell: (c) => <LeverageCell v={c.getValue()} /> },
    ],
    [],
  );

  const tableData = useMemo(() => (pos === 'ALL' ? PLAYERS : PLAYERS.filter((p) => p.pos.split('/').includes(pos))), [pos]);

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-6 sm:px-6">
      <header>
        <h1 className="text-lg font-semibold text-fg">UI Kit</h1>
        <p className="text-xs text-fg-muted">
          Shared components in <code className="num text-fg">src/components/ui</code>. Toggle the theme in the top bar to check both palettes.
        </p>
      </header>

      <Section title="Stat tiles" description="KPI tiles. Numbers use the tabular mono face so they align.">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Stat label="Projected pts" value="287.4" delta={6.2} deltaLabel="vs avg" />
          <Stat label="Salary used" value="$49,800" hint="$200 left" />
          <Stat label="Total own" value="112.6" unit="%" delta={-14.3} deltaTone="positive" deltaLabel="chalk" />
          <Stat label="Lineups" value="150" icon={<IconBolt size={14} />} hint="20 unique players" />
        </div>
      </Section>

      <Section title="DataTable" description="Click headers to sort. Sticky header, column visibility, density toggle, global filter.">
        <DataTable
          data={tableData}
          columns={columns}
          density={density}
          loading={loading}
          maxHeight={320}
          globalFilter={search}
          initialSorting={[{ id: 'proj', desc: true }]}
          initialColumnVisibility={{ ceil: false }}
          getRowId={(r) => String(r.id)}
          rowClassName={(r) => (r.own >= 25 ? 'bg-caution-soft/40' : undefined)}
          toolbar={
            <>
              <Input
                aria-label="Search players"
                placeholder="Search…"
                leftIcon={<IconSearch size={13} />}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-44"
              />
              <Tabs
                variant="pill"
                size="sm"
                value={pos}
                onChange={setPos}
                tabs={['ALL', 'PG', 'SG', 'SF', 'PF', 'C'].map((p) => ({ value: p, label: p }))}
              />
              <div className="ml-auto flex items-center gap-2">
                <Toggle size="sm" label={<span className="text-xs">Comfortable</span>} checked={density === 'comfortable'} onChange={(on) => setDensity(on ? 'comfortable' : 'compact')} />
                <Button size="sm" variant="ghost" onClick={() => { setLoading(true); setTimeout(() => setLoading(false), 1200); }}>
                  Reload
                </Button>
              </div>
            </>
          }
          emptyState={<EmptyState compact title="No players match" description="Clear the search or position filter." />}
        />
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Buttons">
          <Card>
            <CardBody className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary">Optimize</Button>
                <Button>Secondary</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="positive">Lock</Button>
                <Button variant="danger">Exclude</Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="xs">xs</Button>
                <Button size="sm">sm</Button>
                <Button size="md">md</Button>
                <Button size="lg">lg</Button>
                <Button size="icon" aria-label="Boost"><IconBolt size={14} /></Button>
                <Button variant="primary" loading>Solving</Button>
                <Button disabled>Disabled</Button>
              </div>
            </CardBody>
          </Card>
        </Section>

        <Section title="Badges" description="Semantic tones for value, ownership and leverage signals.">
          <Card>
            <CardBody className="flex flex-wrap items-center gap-2">
              <Badge>Neutral</Badge>
              <Badge tone="accent">Locked</Badge>
              <Badge tone="positive" dot>Value</Badge>
              <Badge tone="negative" dot>Fade</Badge>
              <Badge tone="caution" dot>Chalk</Badge>
              <Badge tone="info">Low own</Badge>
              <Badge tone="negative" size="sm">OUT</Badge>
              <Badge tone="caution" size="sm">GTD</Badge>
              <Badge tone="positive" size="sm">+Lev</Badge>
            </CardBody>
          </Card>
        </Section>

        <Section title="Form controls">
          <Card>
            <CardBody className="grid gap-3 sm:grid-cols-2">
              <Input label="Lineups" type="number" numeric defaultValue={20} min={1} max={150} />
              <Select label="Contest type" defaultValue="gpp" options={[{ value: 'gpp', label: 'GPP' }, { value: 'cash', label: 'Cash' }, { value: 'se', label: 'Single entry' }]} />
              <Input label="Min salary" numeric defaultValue="49000" hint="DraftKings cap is $50,000" />
              <Input label="Player" placeholder="Search…" error="Player not on slate" />
              <Slider label="Max exposure" value={exposure} onChange={setExposure} min={0} max={100} format={(v) => `${v}%`} />
              <Slider label="Min uniques" value={uniques} onChange={setUniques} min={1} max={6} />
              <Toggle label="Late swap" description="Re-optimize after locks" checked={lateSwap} onChange={setLateSwap} />
              <Toggle label="Game stacks" checked={stacks} onChange={setStacks} />
            </CardBody>
          </Card>
        </Section>

        <Section title="Tabs">
          <Card>
            <CardBody className="space-y-4">
              <Tabs
                tabs={[
                  { value: 'pool', label: 'Pool', count: 214, content: <p className="text-xs text-fg-muted">Underline tabs for page sections. Arrow keys move between tabs.</p> },
                  { value: 'locks', label: 'Locks', count: 2, content: <p className="text-xs text-fg-muted">Locked players panel.</p> },
                  { value: 'excl', label: 'Excluded', count: 0, content: <p className="text-xs text-fg-muted">Excluded players panel.</p> },
                  { value: 'off', label: 'Disabled', disabled: true },
                ]}
              />
              <Tabs variant="pill" defaultValue="dk" tabs={[{ value: 'dk', label: 'DraftKings' }, { value: 'fd', label: 'FanDuel' }]} />
            </CardBody>
          </Card>
        </Section>

        <Section title="Card, Tooltip, Modal, Spinner">
          <Card>
            <CardHeader
              title="Slate summary"
              subtitle="Main · 9 games"
              actions={
                <Tooltip content="Ownership projections refresh every 15 minutes">
                  <Button size="sm" variant="ghost">Hover me</Button>
                </Tooltip>
              }
            />
            <CardBody className="flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={() => setModalOpen(true)}>Open modal</Button>
              <Tooltip content="Bottom tooltip" side="bottom"><Badge tone="info">Tooltip (bottom)</Badge></Tooltip>
              <Spinner size="xs" />
              <Spinner size="sm" />
              <Spinner size="md" />
            </CardBody>
          </Card>
        </Section>

        <Section title="Empty state">
          <Card>
            <EmptyState
              title="No lineups yet"
              description="Run the optimizer to generate lineups for this slate."
              action={<Button variant="primary" size="sm">Go to optimizer</Button>}
            />
          </Card>
        </Section>
      </div>

      <Section title="Color tokens" description="Defined as CSS variables in src/styles/theme.css; used as Tailwind colors (bg-surface, text-positive, …).">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-9">
          {['canvas', 'surface', 'surface-raised', 'surface-sunken', 'line', 'accent', 'positive', 'negative', 'caution', 'info', 'fg', 'fg-muted', 'fg-subtle'].map((t) => (
            <div key={t} className="overflow-hidden rounded border border-line">
              <div className="h-8" style={{ background: `rgb(var(--${t}))` }} />
              <div className="num truncate bg-surface px-1.5 py-1 text-2xs text-fg-muted">{t}</div>
            </div>
          ))}
        </div>
      </Section>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Export lineups"
        description="Download a DraftKings-ready CSV."
        footer={
          <>
            <Button variant="ghost" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => setModalOpen(false)}>Export</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Select label="Lineup set" options={['All 150', 'Top 20 by proj', 'Selected']} />
          <Toggle label="Include projections column" checked={stacks} onChange={setStacks} />
        </div>
      </Modal>
    </div>
  );
}
