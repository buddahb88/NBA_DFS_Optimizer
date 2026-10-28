// Every suite starts on RotoWire projections (the app before the own model):
// fixtures are tiny temp DBs the own model cannot fit, and the projection
// source tests set PROJECTION_SOURCE / the runtime setting themselves.
process.env.PROJECTION_SOURCE = 'rotowire';
