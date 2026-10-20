// Pit Wall helpers shared by every screen: three-letter circuit codes and country stripes.
// See docs/pit-wall.md.

/** Words that say "kart track" rather than which one. */
const FILLER = new Set([
  'karting', 'kart', 'karts', 'go', 'gokart', 'gokarts', 'circuit', 'circuito', 'raceway', 'speedway', 'track', 'park', 'center', 'centre',
  'international', 'internacional', 'internazionale', 'kartodromo', 'kartódromo', 'kartodrom', 'kartbahn', 'pista', 'piste', 'the', 'de', 'del', 'di', 'da',
  'do', 'la', 'le', 'el', 'and', 'of', 'motorsport', 'motorsports', 'racing', 'club', 'arena', 'indoor', 'outdoor', 'complex', 'motor', 'ring',
]);

const plain = (w: string) => w.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '');

/**
 * A three-letter code for a circuit, like a driver code on a timing tower: "KF1 Karting Circuit"
 * → KF1, "Karting Genk" → GNK, "South Garda Karting" → SGR, "Buckmore Park" → BCK.
 */
export function circuitCode(name: string): string {
  const words = name.split(/[\s\-–—/·,()]+/).map(plain).filter(Boolean);
  const named = words.find((w) => /\d/.test(w) && /[A-Za-z]/.test(w) && w.length <= 4);
  if (named) return named.toUpperCase().slice(0, 3);
  // Initials already in the name ("PF International", "SH Karting"): keep them, then the next word.
  const at = words.findIndex((w) => /^[A-Z]{2,3}$/.test(w));
  if (at >= 0) return (words[at] + (words[at + 1]?.[0] ?? 'K')).toUpperCase().slice(0, 3);
  const key = words.filter((w) => !FILLER.has(w.toLowerCase()));
  const use = key.length ? key : words;
  if (!use.length) return 'TRK';
  if (use.length >= 3) return use.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
  if (use.length === 2) {
    // "South Garda" → SGR, "Rye House" → RHS: both initials, then the second word's next consonant.
    const [a, b] = use;
    return (a[0] + b[0] + (consonants(b)[1] ?? b[1] ?? 'X')).toUpperCase();
  }
  const w = use[0];
  const c = consonants(w);
  return (w[0] + (c[1] ?? w[1] ?? 'X') + (c[2] ?? w[w.length - 1] ?? 'X')).toUpperCase();
}

function consonants(w: string): string[] {
  return [w[0], ...w.slice(1).replace(/[aeiouyAEIOUY]/g, '').split('')];
}

/** The two main colours of a country's flag, for the stripe beside its name (ISO 3166 alpha-3). */
const FLAG: Record<string, [string, string]> = {
  ARE: ['#00732F', '#FF0000'], ARG: ['#74ACDF', '#FFFFFF'], AUS: ['#2A4BB8', '#E4002B'], AUT: ['#ED2939', '#FFFFFF'], BEL: ['#FDDA24', '#EF3340'],
  BGR: ['#00966E', '#D62612'], BHR: ['#CE1126', '#FFFFFF'], BRA: ['#009C3B', '#FFDF00'], CAN: ['#FF0000', '#FFFFFF'], CHE: ['#FF0000', '#FFFFFF'],
  CHL: ['#0039A6', '#D52B1E'], CHN: ['#EE1C25', '#FFFF00'], COL: ['#FCD116', '#003893'], CRI: ['#002B7F', '#CE1126'], CZE: ['#11457E', '#D7141A'],
  DEU: ['#111111', '#FFCE00'], DNK: ['#C8102E', '#FFFFFF'], ECU: ['#FFDD00', '#034EA2'], EGY: ['#CE1126', '#111111'], ESP: ['#AA151B', '#F1BF00'],
  EST: ['#0072CE', '#111111'], FIN: ['#002F6C', '#FFFFFF'], FRA: ['#0055A4', '#EF4135'], GBR: ['#2A4BB8', '#C8102E'], GRC: ['#0D5EAF', '#FFFFFF'],
  GTM: ['#4997D0', '#FFFFFF'], HKG: ['#DE2910', '#FFFFFF'], HRV: ['#FF0000', '#171796'], HUN: ['#CE2939', '#477050'], IDN: ['#FF0000', '#FFFFFF'],
  IND: ['#FF9933', '#138808'], IRL: ['#169B62', '#FF883E'], IRN: ['#239F40', '#DA0000'], ISL: ['#02529C', '#DC1E35'], ISR: ['#0038B8', '#FFFFFF'],
  ITA: ['#009246', '#CE2B37'], JPN: ['#FFFFFF', '#BC002D'], KAZ: ['#00AFCA', '#FEC50C'], KOR: ['#FFFFFF', '#CD2E3A'], KWT: ['#007A3D', '#CE1126'],
  LBN: ['#ED1C24', '#00A651'], LTU: ['#FDB913', '#006A44'], LUX: ['#EF3340', '#00A3E0'], LVA: ['#9E3039', '#FFFFFF'], MAR: ['#C1272D', '#006233'],
  MEX: ['#006847', '#CE1126'], MLT: ['#FFFFFF', '#CF142B'], MYS: ['#2B2BB0', '#FFCC00'], NGA: ['#008751', '#FFFFFF'], NLD: ['#AE1C28', '#21468B'],
  NOR: ['#BA0C2F', '#00205B'], NZL: ['#00247D', '#CC142B'], OMN: ['#DB161B', '#008000'], PAN: ['#DA121A', '#072357'], PER: ['#D91023', '#FFFFFF'],
  PHL: ['#0038A8', '#CE1126'], POL: ['#FFFFFF', '#DC143C'], PRT: ['#046A38', '#DA291C'], PRY: ['#D52B1E', '#0038A8'], QAT: ['#8A1538', '#FFFFFF'],
  ROU: ['#002B7F', '#FCD116'], RUS: ['#FFFFFF', '#0039A6'], SAU: ['#006C35', '#FFFFFF'], SGP: ['#EF3340', '#FFFFFF'], SRB: ['#C6363C', '#0C4076'],
  SVK: ['#0B4EA2', '#EE1C25'], SVN: ['#005DA4', '#ED1C24'], SWE: ['#006AA7', '#FECC02'], THA: ['#A51931', '#2D2A4A'], TUR: ['#E30A17', '#FFFFFF'],
  TWN: ['#FE0000', '#000095'], UKR: ['#0057B7', '#FFD700'], URY: ['#0038A8', '#FFFFFF'], USA: ['#3C3B6E', '#B22234'], VEN: ['#FFCC00', '#CF142B'],
  VNM: ['#DA251D', '#FFFF00'], ZAF: ['#007749', '#FFB81C'], ZMB: ['#198A00', '#EF7D00'], TGO: ['#006A4E', '#FFCE00'], KEN: ['#111111', '#BB0000'],
  DOM: ['#002D62', '#CE1126'], BLR: ['#C8313E', '#4AA657'], CYP: ['#FFFFFF', '#D57800'], JOR: ['#111111', '#007A3D'], PRI: ['#ED0000', '#0050F0'],
};

/** Flag colours for a country code; unknown codes get a steady pair of greys. */
export function flagColors(cc: string | undefined | null): [string, string] {
  return (cc && FLAG[cc]) || ['#8a90a0', '#3a3e48'];
}

/** Inline style for a .pw-stripe. */
export function stripeStyle(cc: string | undefined | null): string {
  const [a, b] = flagColors(cc);
  return `--c1:${a};--c2:${b}`;
}
