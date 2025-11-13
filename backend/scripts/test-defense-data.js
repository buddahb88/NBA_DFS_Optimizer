import espnScraperService from '../src/services/espnScraperService.js';

console.log('🔍 Testing ESPN defense data scraping...\n');

try {
  const result = await espnScraperService.fetchAndStoreDefenseRankings();

  console.log(`\n✅ Scraping result: ${result.success}`);
  console.log(`   Teams found: ${result.count}`);

  if (result.teams) {
    // Check if Houston is in the results
    const houston = result.teams.find(t => t.team === 'HOU');

    if (houston) {
      console.log('\n✅ HOUSTON FOUND:');
      console.log(houston);
    } else {
      console.log('\n❌ HOUSTON NOT FOUND');
      console.log('\nAll teams found:');
      result.teams.forEach(t => console.log(`  - ${t.team}: DEF ${t.defEff}`));
    }
  }
} catch (error) {
  console.error('❌ Error:', error.message);
}
