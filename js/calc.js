// Rechenkern: Tageswerte, Monatswerte, Kalibrierung und Hochrechnung.
// Alle Tage werden als ganze Zahl "Tage seit 1970-01-01 (UTC)" geführt,
// damit Sommer-/Winterzeit keine Rolle spielt.

// Typische Monatsprofile (Jan..Dez), relative Gewichte.
export const PROFILE = {
  flach:  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  // Wärmepumpe: Heizgradtage Norddeutschland + Warmwasser im Sommer
  wp:     [17, 14, 12, 7, 4, 2.5, 2.5, 2.5, 3.5, 7, 12, 16],
  // PV-Ertrag / Einspeisung Norddeutschland
  pv:     [2, 4, 8, 12, 14, 14, 14, 12, 9, 6, 3, 2],
  // Netzbezug mit Wärmepumpe: Winter hoch, Sommer niedrig
  bezug:  [15, 12, 10, 6, 4, 3, 3, 3, 4, 8, 13, 15],
};

export function toDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 864e5);
}

export function fromDay(n) {
  return new Date(n * 864e5).toISOString().slice(0, 10);
}

export function monatsKey(day) {
  return fromDay(day).slice(0, 7);
}

function tageImMonat(y, m0) {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

export function gewicht(profil, day) {
  const d = new Date(day * 864e5);
  const m = d.getUTCMonth();
  const p = PROFILE[profil] || PROFILE.flach;
  return p[m] / tageImMonat(d.getUTCFullYear(), m);
}

// Verlauf einer Quelle in Tageswerte zerlegen.
// Zählerstände: Differenz zweier Ablesungen wird nach Profil auf die Tage verteilt.
// Verbrauch: Wert wird gleichmäßig auf die Tage des Zeitraums verteilt.
export function serie(quelle, eintraege) {
  const daily = new Map();
  const dailyEuro = new Map();
  const verteilt = new Set(); // Tage, die aus langen Ablese-Intervallen geschätzt sind
  let first = null, last = null;
  const add = (m, d, v) => m.set(d, (m.get(d) || 0) + v);

  if (quelle.art === 'zaehlerstand') {
    const byDay = new Map();
    byDay.set(toDay(quelle.startDatum), Number(quelle.startStand) || 0);
    for (const e of eintraege) byDay.set(toDay(e.datum), Number(e.wert));
    const pts = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < pts.length - 1; i++) {
      const [d0, v0] = pts[i], [d1, v1] = pts[i + 1];
      const delta = v1 - v0;
      let sw = 0;
      for (let d = d0; d < d1; d++) sw += gewicht(quelle.profil, d);
      const lang = d1 - d0 > 40;
      for (let d = d0; d < d1; d++) {
        add(daily, d, sw > 0 ? delta * gewicht(quelle.profil, d) / sw : 0);
        if (lang) verteilt.add(d);
      }
    }
    if (pts.length >= 2) { first = pts[0][0]; last = pts[pts.length - 1][0] - 1; }
  } else {
    for (const e of eintraege) {
      const von = toDay(e.vonDatum || e.datum), bis = toDay(e.datum);
      if (bis < von) continue;
      const n = bis - von + 1;
      for (let d = von; d <= bis; d++) {
        add(daily, d, Number(e.wert) / n);
        if (e.betragEuro != null && e.betragEuro !== '') add(dailyEuro, d, Number(e.betragEuro) / n);
      }
      first = first == null ? von : Math.min(first, von);
      last = last == null ? bis : Math.max(last, bis);
    }
  }
  return { daily, dailyEuro, verteilt, first, last };
}

// Niveau der Quelle bestimmen: echte Werte der letzten 365 Tage / Profil.
export function kalibrierung(quelle, s) {
  if (s.first == null || s.last < s.first) return null;
  const von = Math.max(s.first, s.last - 364);
  let ist = 0, w = 0, euro = 0, verteilt = 0;
  for (let d = von; d <= s.last; d++) {
    ist += s.daily.get(d) || 0;
    euro += s.dailyEuro.get(d) || 0;
    w += gewicht(quelle.profil, d);
    if (s.verteilt.has(d)) verteilt++;
  }
  const tage = s.last - s.first + 1;
  return {
    k: w > 0 ? ist / w : 0,
    euroProKwh: ist > 0 ? euro / ist : 0,
    tage,
    // Unsicherheit: 5 % Grundrauschen
    //  + bis zu 15 %, solange kein volles Jahr vorliegt
    //  + bis zu 10 %, wenn die Monate nur geschätzt verteilt sind (wenige Ablesungen)
    spanne: 0.05 + 0.15 * (1 - Math.min(1, tage / 365)) + 0.10 * (verteilt / (s.last - von + 1)),
  };
}

// Wert einer Quelle an einem Tag: echt (ist) oder hochgerechnet.
export function tag(Q, d) {
  const { s, kal, quelle } = Q;
  if (s.first != null && d >= s.first && d <= s.last) {
    return { kwh: s.daily.get(d) || 0, euro: s.dailyEuro.get(d) || 0, ist: true };
  }
  if (kal && s.last != null && d > s.last) {
    const kwh = kal.k * gewicht(quelle.profil, d);
    return { kwh, euro: kwh * kal.euroProKwh, ist: false };
  }
  return { kwh: 0, euro: 0, ist: false, leer: true };
}

// Monatswerte (nur echte Daten).
export function monate(Q) {
  const { s } = Q;
  const out = new Map();
  if (s.first == null) return [];
  for (let d = s.first; d <= s.last; d++) {
    const k = monatsKey(d);
    if (!out.has(k)) out.set(k, { monat: k, kwh: 0, euro: 0, tage: 0, verteilt: false });
    const o = out.get(k);
    o.kwh += s.daily.get(d) || 0;
    o.euro += s.dailyEuro.get(d) || 0;
    o.tage++;
    if (s.verteilt.has(d)) o.verteilt = true;
  }
  for (const o of out.values()) {
    const [y, m] = o.monat.split('-').map(Number);
    o.voll = o.tage >= tageImMonat(y, m - 1);
  }
  return [...out.values()];
}

// Gültigen Tarif an einem Tag finden.
export function tarifAm(tarife, bereich, day) {
  let best = null;
  for (const t of tarife) {
    if (t.bereich !== bereich) continue;
    const ab = toDay(t.gueltigAb);
    if (ab <= day && (!best || ab > toDay(best.gueltigAb))) best = t;
  }
  return best;
}

function addMonate(dayStr, n) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const dim = tageImMonat(y, m - 1 + n);
  return toDay(new Date(Date.UTC(y, m - 1 + n, Math.min(d, dim))).toISOString().slice(0, 10));
}

// Laufendes Abrechnungsjahr, das den Tag t enthält.
export function abrechnungsjahr(einst, t) {
  const [y0, m, d] = einst.abrechnungStart.split('-').map(Number);
  const jahrVon = (y) => toDay(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  let y = new Date(t * 864e5).getUTCFullYear();
  if (jahrVon(y) > t) y--;
  const a = jahrVon(y), b = jahrVon(y + 1) - 1;
  // Abschläge: 12 Stück ab erstem Abschlag, ins aktuelle Jahr verschoben
  const versatz = y - y0;
  const [ay, am, ad] = einst.ersterAbschlag.split('-').map(Number);
  const erster = `${ay + versatz}-${String(am).padStart(2, '0')}-${String(ad).padStart(2, '0')}`;
  const abschlaege = [];
  for (let i = 0; i < 12; i++) abschlaege.push(addMonate(erster, i));
  return { a, b, abschlaege };
}

// Monatsanfänge (1. des Monats), die in [a,b] liegen (für Monats-Grundgebühren).
export function monatsAnfaenge(a, b) {
  const out = [];
  const d0 = new Date(a * 864e5);
  let y = d0.getUTCFullYear(), m = d0.getUTCMonth();
  for (;;) {
    const start = Math.round(Date.UTC(y, m, 1) / 864e5);
    if (start > b) break;
    if (start >= a) out.push(start);
    m++; if (m > 11) { m = 0; y++; }
  }
  return out;
}
