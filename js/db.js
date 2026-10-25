// Speicherung im Browser des iPhones (IndexedDB), Fallback localStorage.
const DB_NAME = 'strom-tagebuch';
const STORE = 'kv';
const KEY = 'state';

export function neueId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function defaultState() {
  return {
    version: 1,
    quellen: [
      { id: 'bezug', name: 'Netzbezug 1.8.0', kurz: 'Bezug', art: 'zaehlerstand', profil: 'bezug', startDatum: '2025-08-08', startStand: 0 },
      { id: 'einspeisung', name: 'Einspeisung 2.8.0', kurz: 'Einspeisung', art: 'zaehlerstand', profil: 'pv', startDatum: '2025-08-08', startStand: 0 },
      { id: 'waermepumpe', name: 'Wärmepumpe (Wolf)', kurz: 'Wärmepumpe', art: 'zaehlerstand', profil: 'wp', startDatum: '2025-12-06', startStand: 0 },
      { id: 'wallbox', name: 'Wallbox (eSee)', kurz: 'Wallbox', art: 'verbrauch', profil: 'flach' },
      { id: 'enbw', name: 'Auswärts laden (EnBW)', kurz: 'EnBW', art: 'verbrauch', profil: 'flach', mitBetrag: true },
    ],
    eintraege: [],
    tarife: [
      { id: neueId(), bereich: 'haus', anbieter: 'EWE', name: '', gueltigAb: '2000-01-01', arbeitspreisCent: 28, grundpreisJahr: 0 },
      { id: neueId(), bereich: 'haus', anbieter: 'E.ON', name: 'ÖkoStrom Pro Extra 12', gueltigAb: '2026-07-25', arbeitspreisCent: 21.65, grundpreisJahr: 267.85 },
      { id: neueId(), bereich: 'auswaerts', anbieter: 'EnBW', name: '', gueltigAb: '2000-01-01', arbeitspreisCent: 56, grundpreisMonat: 0 },
      { id: neueId(), bereich: 'auswaerts', anbieter: 'EnBW', name: '', gueltigAb: '2026-10-01', arbeitspreisCent: 39, grundpreisMonat: 11.99 },
    ],
    einstellungen: {
      einspeiseverguetungCent: 7,
      abrechnungStart: '2026-07-25',
      abschlagEuro: 113,
      ersterAbschlag: '2026-08-10',
    },
    ewe: eweStandard(),
  };
}

// Einspeisevergütung EWE NETZ (eigene Abrechnung, nicht mit E.ON verrechnet)
export function eweStandard() {
  return {
    verguetungNettoCent: 8.2,
    mwst: true,                    // EWE zahlt 19 % MwSt obendrauf
    netzbetreiber: 'EWE',
    abrechnungStart: '2026-04-01', // Übergangszeitraum, danach Kalenderjahr
    abrechnungEnde: '2026-12-31',
    abschlagEuro: 60,
    ersterAbschlag: '2026-05-15',
    letzterAbschlag: '2027-01-15',
  };
}

// Ältere Datenstände auf den aktuellen Aufbau bringen
export function migrieren(state) {
  if (!state.ewe) state.ewe = eweStandard();
  if (!state.ewe.netzbetreiber) state.ewe.netzbetreiber = 'EWE';
  for (const q of state.quellen) if (q.aktiv === undefined) q.aktiv = true;
  return state;
}

// Neue, leere Installation aus den Angaben der Einrichtung
export function neuerState(c) {
  const zaehler = (id, name, kurz, profil, aktiv, stand) =>
    ({ id, name, kurz, art: 'zaehlerstand', profil, aktiv, startDatum: c.startDatum, startStand: stand || 0 });
  const s = {
    version: 1,
    quellen: [
      zaehler('bezug', 'Netzbezug 1.8.0', 'Bezug', 'bezug', true, c.startBezug),
      zaehler('einspeisung', 'Einspeisung 2.8.0', 'Einspeisung', 'pv', c.pv, c.startEinspeisung),
      zaehler('waermepumpe', 'Wärmepumpe', 'Wärmepumpe', 'wp', c.wp, c.startWp),
      { id: 'wallbox', name: 'Wallbox', kurz: 'Wallbox', art: 'verbrauch', profil: 'flach', aktiv: c.wallbox },
      { id: 'enbw', name: 'Laden unterwegs', kurz: 'Unterwegs', art: 'verbrauch', profil: 'flach', mitBetrag: true, aktiv: c.unterwegs },
    ],
    eintraege: [],
    tarife: [
      { id: neueId(), bereich: 'haus', anbieter: c.anbieter || 'Stromanbieter', name: '', gueltigAb: '2000-01-01',
        arbeitspreisCent: c.arbeitspreisCent || 0, grundpreisJahr: c.grundpreisJahr || 0 },
    ],
    einstellungen: {
      einspeiseverguetungCent: 0,
      abrechnungStart: c.abrechnungStart,
      abschlagEuro: c.abschlagEuro || 0,
      ersterAbschlag: c.ersterAbschlag || c.abrechnungStart,
    },
    ewe: {
      netzbetreiber: c.netzbetreiber || 'Netzbetreiber',
      verguetungNettoCent: c.verguetungNettoCent || 0,
      mwst: !!c.mwst,
      abrechnungStart: c.eweStart || c.abrechnungStart,
      abrechnungEnde: c.eweEnde || c.abrechnungStart,
      abschlagEuro: c.eweAbschlag || 0,
      ersterAbschlag: c.eweErsterAbschlag || '',
      letzterAbschlag: c.eweLetzterAbschlag || '',
    },
  };
  if (c.unterwegs) s.tarife.push({ id: neueId(), bereich: 'auswaerts', anbieter: c.unterwegsAnbieter || 'Ladeanbieter', name: '',
    gueltigAb: '2000-01-01', arbeitspreisCent: c.unterwegsCent || 0, grundpreisMonat: c.unterwegsGrund || 0 });
  return s;
}

function oeffnen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function laden() {
  try {
    const db = await oeffnen();
    return await new Promise((res, rej) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    });
  } catch {
    try { const s = localStorage.getItem(DB_NAME); return s ? JSON.parse(s) : null; } catch { return null; }
  }
}

export async function speichern(state) {
  try {
    const db = await oeffnen();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(state, KEY);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  } catch {
    try { localStorage.setItem(DB_NAME, JSON.stringify(state)); } catch { /* nichts zu tun */ }
  }
}

// Bitte iOS, die Daten nicht automatisch zu löschen.
export function dauerhaftAnfragen() {
  try { navigator.storage?.persist?.(); } catch { /* egal */ }
}
