/**
 * Demo bus photos, free to use under the Unsplash License (https://unsplash.com/license).
 * They load from Unsplash's CDN, so the site needs an internet connection to show them.
 * Operators replace these with their own photos from the dashboard (Buses → Photos).
 */
const u = (id, w = 1400) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&q=80`;

const P = {
  nightCoach: u('photo-1544620347-c4fd4a3d5957'), // coach on a mountain road at night (Juan Encalada)
  highwayCoach: u('photo-1726696211907-86f60b3187e2'), // coach on an open highway (Marco Antonio Casique Reyes)
  forestHighway: u('photo-1631769061480-baac95ff4b29'), // highway through forest with a bus (Nicholas Ng)
  cabin: u('photo-1753169117355-664920778aea'), // cabin interior looking forward (Lucie Perrin)
  seat: u('photo-1597388522438-8f99f4cf354b'), // seat close-up (Al Soot)
  driver: u('photo-1698465358843-5f5a24271bfd'), // driver at the wheel (Karthick Gislen)
};

// Gallery per demo bus (keyed by registration number). The first photo is the cover.
const BUS_PHOTOS = {
  // Sleepers: night coach cover
  OD02CD5678: [P.nightCoach, P.seat, P.cabin],
  OD05BB2222: [P.nightCoach, P.cabin, P.seat],
  OD13RS5555: [P.nightCoach, P.seat, P.driver],
  // AC / luxury seaters: highway coach cover
  OD05AA1111: [P.highwayCoach, P.cabin, P.seat],
  OD02GH3456: [P.highwayCoach, P.seat, P.cabin],
  OD13PQ4444: [P.highwayCoach, P.cabin, P.driver],
  OD01XY7777: [P.highwayCoach, P.seat, P.driver],
  OD01PP9999: [P.highwayCoach, P.cabin],
  OD02AB1234: [P.forestHighway, P.cabin, P.seat],
  // Non-AC / regional: forest highway cover
  OD02EF9012: [P.forestHighway, P.driver, P.cabin],
  OD05CC3333: [P.forestHighway, P.driver],
  OD13TU6666: [P.forestHighway, P.cabin, P.driver],
  OD01ZZ8888: [P.forestHighway, P.driver, P.seat],
  OD02JK7788: [P.forestHighway, P.driver],
  OD07SB1010: [P.forestHighway, P.driver],
};

// Landmark photo per city (keyed by city name). Free under the Unsplash License.
const CITY_PHOTOS = {
  Bhubaneswar: { image: u('photo-1695692928769-7b4eec3803fa', 1200), imageCredit: 'Lingaraj Temple · Anish Mathew Jose / Unsplash' },
  Cuttack: { image: u('photo-1642915680258-6aaca62d3849', 1200), imageCredit: 'Ravenshaw University · streets of india / Unsplash' },
  Puri: { image: u('photo-1610205847679-f6435c171701', 1200), imageCredit: 'Puri beach at sunset · Maitrayee Raha / Unsplash' },
  Konark: { image: u('photo-1576235282476-debff2a4d0b9', 1200), imageCredit: 'Konark Sun Temple · Ujjval Verma / Unsplash' },
  Kolkata: { image: u('photo-1742325646212-f917ba1feeaa', 1200), imageCredit: 'Howrah Bridge · Paras Verma / Unsplash' },
  Visakhapatnam: { image: u('photo-1638705350009-e8c85668d2ef', 1200), imageCredit: 'RK Beach · Vizag Explore / Unsplash' },
  Sambalpur: { image: u('photo-1721164311027-9fd333509be4', 1200), imageCredit: 'Sambalpur from the hills · Pic Shala / Unsplash' },
};

module.exports = { BUS_PHOTOS, CITY_PHOTOS, PHOTOS: P };
