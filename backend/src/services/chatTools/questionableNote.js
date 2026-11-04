/**
 * build_lineup payload fields for the optimizer's skipQuestionable result:
 * { skippedQuestionable: { enabled, count, players: [names] }, questionableNote }
 * ({} when the skip was off and nothing was skipped).
 */
export function questionableNote(skipped) {
  if (!skipped) return {};
  if (!skipped.enabled) {
    return { skippedQuestionable: { enabled: false, count: 0 }, questionableNote: 'Questionable players were allowed (GPP default); their projections are discounted by their chance to play.' };
  }
  const names = skipped.players.map(p => p.name);
  return {
    skippedQuestionable: { enabled: true, count: skipped.count, players: names },
    questionableNote: skipped.count
      ? `Skipped ${skipped.count} questionable player(s) (cash default; lock one or pass skipQuestionable: false to allow): ${names.join(', ')}`
      : 'No questionable players to skip.'
  };
}

export default { questionableNote };
