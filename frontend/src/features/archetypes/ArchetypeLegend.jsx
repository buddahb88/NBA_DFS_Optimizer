import { Card, CardBody, CardHeader, Spinner } from '../../components/ui';

/** Archetype definitions (labels + descriptions from config/archetypes.js). */
export default function ArchetypeLegend({ definitions }) {
  const archetypes = definitions.data?.archetypes ?? [];
  return (
    <Card>
      <CardHeader title="Archetype legend" subtitle="Rule-based, per season; a player missing this season uses last season’s" />
      <CardBody>
        {definitions.status === 'loading' && !archetypes.length ? (
          <div className="flex justify-center py-4">
            <Spinner size="sm" />
          </div>
        ) : definitions.status === 'error' ? (
          <p className="text-xs text-negative">Couldn’t load archetype definitions: {definitions.error}</p>
        ) : (
          <dl className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {archetypes.map((a) => (
              <div key={a.key}>
                <dt className="text-xs font-semibold text-fg">{a.label}</dt>
                <dd className="text-2xs text-fg-muted">{a.description}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardBody>
    </Card>
  );
}
