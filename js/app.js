import { laden, speichern, defaultState, neueId, dauerhaftAnfragen, migrieren } from './db.js';
import * as C from './calc.js';

const VERSION = '1.5';

// ---------- Hilfsfunktionen ----------
const nf = (min, max) => new Intl.NumberFormat('de-DE', { minimumFractionDigits: min, maximumFractionDigits: max });
const f0 = nf(0, 0), f1 = nf(0, 1), f2 = nf(2, 2);
const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const eur0 = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const MONATE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const MONATE_LANG = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

const pad = (n) => String(n).padStart(2, '0');
function heute() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function datumDe(s) { if (!s) return ''; const [y, m, d] = s.split('-'); return `${d}.${m}.${y}`; }
function monatDe(key) { const [y, m] = key.split('-'); return `${MONATE_LANG[Number(m) - 1]} ${y}`; }
function monatKurz(key) { const [y, m] = key.split('-'); return `${MONATE[Number(m) - 1]} ${y.slice(2)}`; }
function letzterTag(key) { const [y, m] = key.split('-').map(Number); return `${key}-${pad(new Date(y, m, 0).getDate())}`; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// "5.442,83" / "5442,83" / "5442.83" / "5.416" -> Zahl
function zahl(s) {
  if (s == null) return NaN;
  // Einheiten und Leerzeichen ignorieren ("9250 kWh", "60,03 €")
  let t = String(s).replace(/[^\d.,-]/g, '');
  if (t === '') return NaN;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  return Number(t);
}
const zahlFeld = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? '' : String(v).replace('.', ','));

// ---------- Zustand ----------
let state;
let tab = 'uebersicht';
let verlaufQuelle = 'bezug';
let form = null;
const $view = document.getElementById('view');
const $titel = document.getElementById('titel');

function quelle(id) { return state.quellen.find((q) => q.id === id); }
function eintraegeVon(id) { return state.eintraege.filter((e) => e.quelleId === id); }

async function sichern() { await speichern(state); }

function neuesForm(quelleId = form?.quelleId || 'bezug') {
  const h = heute();
  return { editId: null, quelleId, datum: h, wert: '', monat: h.slice(0, 7), modus: 'monat', vonDatum: h, bisDatum: h, betrag: '', notiz: '' };
}

// ---------- Modell ----------
function modell() {
  const t = C.toDay(heute());
  const jahr = C.abrechnungsjahr(state.einstellungen, t);
  const q = {};
  for (const quelleObj of state.quellen) {
    const s = C.serie(quelleObj, eintraegeVon(quelleObj.id));
    q[quelleObj.id] = { quelle: quelleObj, s, kal: C.kalibrierung(quelleObj, s) };
  }
  return { t, jahr, q };
}

function jahresRechnung(M) {
  const { a, b, abschlaege } = M.jahr;
  const r = {
    bezugIst: 0, bezugProg: 0, arbeitIst: 0, arbeitProg: 0, grundIst: 0, grundProg: 0,
    einIst: 0, einProg: 0, wpIst: 0, wpProg: 0,
    wbIst: 0, wbProg: 0, wbEuroIst: 0, wbEuroProg: 0,
    enIst: 0, enProg: 0, enEuroIst: 0, enEuroProg: 0, enGrundIst: 0, enGrundProg: 0,
    bezugBis: null,
  };
  const verg = eweVerguetung();
  const tageJahr = b - a + 1;
  for (let d = a; d <= b; d++) {
    const tar = C.tarifAm(state.tarife, 'haus', d);
    const preis = tar ? tar.arbeitspreisCent / 100 : 0;
    const grund = tar ? (Number(tar.grundpreisJahr) || 0) / tageJahr : 0;
    if (d <= M.t) r.grundIst += grund; else r.grundProg += grund;

    const tb = C.tag(M.q.bezug, d);
    if (tb.ist) { r.bezugIst += tb.kwh; r.arbeitIst += tb.kwh * preis; r.bezugBis = d; }
    else { r.bezugProg += tb.kwh; r.arbeitProg += tb.kwh * preis; }

    const te = C.tag(M.q.einspeisung, d);
    if (te.ist) r.einIst += te.kwh; else r.einProg += te.kwh;

    const tw = C.tag(M.q.waermepumpe, d);
    if (tw.ist) r.wpIst += tw.kwh; else r.wpProg += tw.kwh;

    const tl = C.tag(M.q.wallbox, d);
    if (tl.ist) { r.wbIst += tl.kwh; r.wbEuroIst += tl.kwh * preis; }
    else { r.wbProg += tl.kwh; r.wbEuroProg += tl.kwh * preis; }

    const tn = C.tag(M.q.enbw, d);
    if (tn.ist) { r.enIst += tn.kwh; r.enEuroIst += tn.euro; }
    else { r.enProg += tn.kwh; r.enEuroProg += tn.euro; }
  }
  for (const ma of C.monatsAnfaenge(a, b)) {
    const tar = C.tarifAm(state.tarife, 'auswaerts', ma);
    const g = tar ? Number(tar.grundpreisMonat) || 0 : 0;
    if (ma <= M.t) r.enGrundIst += g; else r.enGrundProg += g;
  }
  r.einEuroIst = r.einIst * verg;
  r.einEuroProg = r.einProg * verg;
  r.abschlagSumme = abschlaege.length * state.einstellungen.abschlagEuro;
  r.abschlaegeGezahlt = abschlaege.filter((d) => d <= M.t).length;
  r.spBezug = M.q.bezug.kal ? M.q.bezug.kal.spanne : 0.2;
  r.spEin = M.q.einspeisung.kal ? M.q.einspeisung.kal.spanne : 0.2;
  r.spAuto = Math.max(M.q.wallbox.kal?.spanne ?? 0.2, M.q.enbw.kal?.spanne ?? 0.2);
  return r;
}

const spanne = (ist, prog, sp) => [ist + prog * (1 - sp), ist + prog * (1 + sp)];

// ---------- Übersicht ----------
function viewUebersicht() {
  const M = modell();
  const R = jahresRechnung(M);
  const { a, b } = M.jahr;
  const bezugGes = R.bezugIst + R.bezugProg;
  const kostenIst = R.arbeitIst + R.grundIst;
  const kostenGes = kostenIst + R.arbeitProg + R.grundProg;
  const [kMin, kMax] = spanne(kostenIst + R.grundProg, R.arbeitProg, R.spBezug);
  const [bMin, bMax] = spanne(R.bezugIst, R.bezugProg, R.spBezug);
  const diff = kostenGes - R.abschlagSumme;
  const dMin = kMin - R.abschlagSumme, dMax = kMax - R.abschlagSumme;
  const nach = diff > 0;
  const hatDaten = M.q.bezug.s.first != null;

  const restTage = Math.max(0, b - M.t);
  const fortschritt = Math.min(100, Math.round(((M.t - a + 1) / (b - a + 1)) * 100));

  const hero = hatDaten ? `
    <section class="karte hero ${nach ? 'nach' : 'gut'}">
      <div class="label">Hochrechnung bis zur Rechnung am ${datumDe(C.fromDay(b))}</div>
      <div class="gross">${nach ? 'Nachzahlung' : 'Guthaben'} ca. ${eur0.format(Math.abs(diff))}</div>
      <div class="sub">Spanne ${spanneEuro(dMin, dMax)}</div>
      <div class="zeilen">
        <div><span>Netzbezug Jahr</span><b>${f0.format(bMin)}–${f0.format(bMax)} kWh</b></div>
        <div><span>Stromkosten E.ON</span><b>${eur0.format(kMin)}–${eur0.format(kMax)}</b></div>
        <div><span>Abschläge (12 × ${eur0.format(state.einstellungen.abschlagEuro)})</span><b>${eur0.format(R.abschlagSumme)}</b></div>
      </div>
      <div class="balken"><div style="width:${fortschritt}%"></div></div>
      <div class="klein">Abrechnungsjahr ${datumDe(C.fromDay(a))} – ${datumDe(C.fromDay(b))} · noch ${restTage} Tage</div>
    </section>` : `
    <section class="karte hero">
      <div class="gross">Noch keine Werte</div>
      <div class="sub">Trag unter <b>Eingabe</b> deinen aktuellen Zählerstand ein – oder importiere deine Daten unter <b>Einstellungen</b>.</div>
    </section>`;

  const bis = R.bezugBis != null ? datumDe(C.fromDay(R.bezugBis + 1)) : '–';
  const gezahlt = R.abschlaegeGezahlt * state.einstellungen.abschlagEuro;
  const bisher = `
    <section class="karte">
      <h2>E.ON bisher im Abrechnungsjahr</h2>
      <div class="klein">Bezug bis Ablesung ${bis} · Grundpreis bis heute</div>
      <div class="tabelle">
        <div><span>Netzbezug</span><b>${f0.format(R.bezugIst)} kWh</b><em>${eur.format(R.arbeitIst)}</em></div>
        <div><span>Grundpreis</span><b></b><em>${eur.format(R.grundIst)}</em></div>
        <div class="summe"><span>Kosten bisher</span><b></b><em>${eur.format(kostenIst)}</em></div>
        <div><span>Abschläge gezahlt</span><b>${R.abschlaegeGezahlt} von 12</b><em>${eur.format(gezahlt)}</em></div>
        <div class="summe"><span>${gezahlt - kostenIst >= 0 ? 'Zu viel gezahlt' : 'Zu wenig gezahlt'}</span><b></b><em class="${gezahlt - kostenIst >= 0 ? 'plus' : 'minus'}">${eur.format(Math.abs(gezahlt - kostenIst))}</em></div>
      </div>
      ${istVerteilt(M) ? '<p class="hinweis">Die Bezugswerte sind zwischen weit auseinanderliegenden Ablesungen nach Jahreszeit verteilt. Mit monatlichen Zählerständen wird es genauer.</p>' : ''}
    </section>`;

  const einspeisung = eweKarte(M);

  const autoKwhIst = R.wbIst + R.enIst;
  const autoEuroIst = R.wbEuroIst + R.enEuroIst + R.enGrundIst;
  const autoEuroGes = autoEuroIst + R.wbEuroProg + R.enEuroProg + R.enGrundProg;
  const autoKwhGes = autoKwhIst + R.wbProg + R.enProg;
  const auto = `
    <section class="karte">
      <h2>Auto gesamt</h2>
      <div class="tabelle">
        <div><span>Wallbox zu Hause</span><b>${f0.format(R.wbIst)} kWh</b><em>${eur.format(R.wbEuroIst)}</em></div>
        <div><span>EnBW unterwegs</span><b>${f0.format(R.enIst)} kWh</b><em>${eur.format(R.enEuroIst)}</em></div>
        <div><span>EnBW Grundgebühr</span><b></b><em>${eur.format(R.enGrundIst)}</em></div>
        <div class="summe"><span>Bisher im Jahr</span><b>${f0.format(autoKwhIst)} kWh</b><em>${eur.format(autoEuroIst)}</em></div>
      </div>
      <div class="klein">Ø ${autoKwhIst > 0 ? f1.format((autoEuroIst / autoKwhIst) * 100) : '–'} ct/kWh · Hochrechnung Jahr ca. ${f0.format(autoKwhGes)} kWh / ${eur0.format(autoEuroGes)}</div>
    </section>`;

  const kacheln = state.quellen.map((qq) => kachel(M, R, qq)).join('');

  $view.innerHTML = hero + bisher + einspeisung + `<div class="kacheln">${kacheln}</div>` + auto + `<p class="fuss">Version ${VERSION}</p>`;
}

function eweVerguetung() {
  const W = state.ewe;
  return (Number(W.verguetungNettoCent) || 0) * (W.mwst ? 1.19 : 1) / 100; // €/kWh
}

function eweKarte(M) {
  const W = state.ewe;
  const a = C.toDay(W.abrechnungStart), b = C.toDay(W.abrechnungEnde);
  const Q = M.q.einspeisung;
  let ist = 0, prog = 0, bis = null;
  for (let d = a; d <= b; d++) {
    const x = C.tag(Q, d);
    if (x.ist) { ist += x.kwh; bis = d; } else prog += x.kwh;
  }
  const v = eweVerguetung();
  const sp = Q.kal ? Q.kal.spanne : 0.2;
  const [kMin, kMax] = spanne(ist, prog, sp);
  // Abschläge monatlich vom ersten bis zum letzten
  const termine = [];
  if (W.ersterAbschlag && W.letzterAbschlag) {
    const [y, m, dd] = W.ersterAbschlag.split('-').map(Number);
    for (let i = 0; i < 24; i++) {
      const dt = new Date(Date.UTC(y, m - 1 + i, dd)).toISOString().slice(0, 10);
      if (dt > W.letzterAbschlag) break;
      termine.push(dt);
    }
  }
  const abschlagSumme = termine.length * (Number(W.abschlagEuro) || 0);
  const erhalten = termine.filter((d) => C.toDay(d) <= M.t).length;
  const gut = (ist + prog) * v;
  const erg = gut - abschlagSumme, eMin = kMin * v - abschlagSumme, eMax = kMax * v - abschlagSumme;
  const ergText = erg >= 0 ? 'EWE zahlt voraussichtlich nach' : 'Rückzahlung an EWE voraussichtlich';
  const ct = f2.format(v * 100);
  return `
    <section class="karte">
      <h2>Einspeisung – Vergütung EWE</h2>
      <div class="klein">Eigene Abrechnung über den Netzbetreiber, nicht mit E.ON verrechnet<br>
        Zeitraum ${datumDe(W.abrechnungStart)} – ${datumDe(W.abrechnungEnde)} · ${ct} ct/kWh${W.mwst ? ` (${f2.format(W.verguetungNettoCent)} + 19 % MwSt)` : ''}</div>
      <div class="tabelle">
        <div><span>Bisher${bis != null ? ` (bis ${datumDe(C.fromDay(bis + 1)).slice(0, 6)})` : ''}</span><b>${f0.format(ist)} kWh</b><em class="plus">${eur.format(ist * v)}</em></div>
        <div><span>Hochrechnung bis ${datumDe(W.abrechnungEnde).slice(0, 6)}</span><b>${f0.format(kMin)}–${f0.format(kMax)} kWh</b><em class="plus">ca. ${eur0.format(gut)}</em></div>
        <div><span>Abschläge erhalten</span><b>${erhalten} von ${termine.length}</b><em>${eur.format(erhalten * W.abschlagEuro)}</em></div>
        <div><span>Abschläge gesamt</span><b>${termine.length} × ${eur0.format(W.abschlagEuro)}</b><em>${eur.format(abschlagSumme)}</em></div>
        <div class="summe"><span>${ergText}</span><b></b><em class="${erg >= 0 ? 'plus' : 'minus'}">ca. ${eur0.format(Math.abs(erg))}</em></div>
      </div>
      <div class="klein">Spanne ${eMin >= 0 ? '+' : '−'}${eur0.format(Math.abs(eMin))} bis ${eMax >= 0 ? '+' : '−'}${eur0.format(Math.abs(eMax))}</div>
    </section>`;
}

function spanneEuro(min, max) {
  const t = (v) => (v >= 0 ? `${eur0.format(v)} Nachz.` : `${eur0.format(-v)} Guth.`);
  return `${t(min)} bis ${t(max)}`;
}

function istVerteilt(M) {
  const s = M.q.bezug.s;
  for (let d = M.jahr.a; d <= Math.min(M.jahr.b, s.last ?? -1); d++) if (s.verteilt.has(d)) return true;
  return false;
}

function kachel(M, R, qq) {
  const Q = M.q[qq.id];
  const es = eintraegeVon(qq.id).sort((x, y) => (x.datum < y.datum ? 1 : -1));
  const letzter = es[0];
  const map = { bezug: R.bezugIst, einspeisung: R.einIst, waermepumpe: R.wpIst, wallbox: R.wbIst, enbw: R.enIst };
  const seit = `seit ${datumDe(C.fromDay(M.jahr.a)).slice(0, 6)}: ${qq.art === 'zaehlerstand' ? 'ca. ' : ''}${f0.format(map[qq.id] || 0)} kWh`;
  let gross, unter;
  if (qq.art === 'zaehlerstand') {
    gross = letzter ? f2.format(letzter.wert) : '–';
    unter = letzter ? `Zählerstand am ${datumDe(letzter.datum)}` : 'noch keine Ablesung';
  } else {
    gross = f2.format(es.reduce((s, e) => s + Number(e.wert), 0));
    unter = letzter ? `insgesamt erfasst, ${es.length} ${es.length === 1 ? "Eintrag" : "Einträge"}` : 'noch kein Eintrag';
  }
  return `<button class="kachel" data-goto-verlauf="${qq.id}">
    <span class="k-name">${esc(qq.kurz)}</span>
    <span class="k-wert">${gross} <small>kWh</small></span>
    <span class="k-sub">${esc(unter)}</span>
    ${letzter ? `<span class="k-seit">${esc(seit)}</span>` : ''}
  </button>`;
}

// ---------- Eingabe ----------
function viewEingabe(bestaetigung = null) {
  if (!form) form = neuesForm();
  const q = quelle(form.quelleId);
  const chips = state.quellen.map((x) => {
    const n = eintraegeVon(x.id).length;
    return `<button class="chip ${x.id === form.quelleId ? 'an' : ''}" data-quelle="${x.id}">${esc(x.kurz)}${n ? ` <span class="anzahl">${n}</span>` : ''}</button>`;
  }).join('');
  const box = bestaetigung ? `
    <section class="karte bestaetigt">
      <div class="b-haken">✓</div>
      <div><div class="b-titel">${esc(bestaetigung.titel)}</div><div class="b-text">${esc(bestaetigung.text)}</div></div>
    </section>` : '';

  let felder = '';
  if (q.art === 'zaehlerstand') {
    felder = `
      <label>Datum<input type="date" id="f-datum" value="${form.datum}"></label>
      <label>Zählerstand (kWh)<input id="f-wert" inputmode="decimal" class="gross-eingabe" placeholder="0" value="${esc(form.wert)}" autocomplete="off"></label>
      <div id="f-info" class="info"></div>`;
  } else {
    felder = `
      <div class="seg">
        <button class="${form.modus === 'monat' ? 'an' : ''}" data-modus="monat">Monat</button>
        <button class="${form.modus === 'frei' ? 'an' : ''}" data-modus="frei">Zeitraum / Ladevorgang</button>
      </div>
      ${form.modus === 'monat'
        ? `<label>Monat<input type="month" id="f-monat" value="${form.monat}"></label>`
        : `<div class="zwei"><label>von<input type="date" id="f-von" value="${form.vonDatum}"></label><label>bis<input type="date" id="f-bis" value="${form.bisDatum}"></label></div>`}
      <label>Verbrauch (kWh)<input id="f-wert" inputmode="decimal" class="gross-eingabe" placeholder="0" value="${esc(form.wert)}" autocomplete="off"></label>
      ${q.mitBetrag ? `<label>Bezahlt (€)<input id="f-betrag" inputmode="decimal" placeholder="" value="${esc(form.betrag)}" autocomplete="off"></label>` : ''}
      <div id="f-info" class="info"></div>`;
  }

  $view.innerHTML = box + `
    <section class="karte">
      <div class="chips">${chips}</div>
      <h2>${esc(q.name)}${form.editId ? ' <span class="badge">bearbeiten</span>' : ''}</h2>
      ${felder}
      <label>Notiz (optional)<input id="f-notiz" value="${esc(form.notiz)}" autocomplete="off"></label>
      <button class="primaer" id="f-speichern">${form.editId ? 'Änderung speichern' : 'Speichern'}</button>
      ${form.editId ? '<button class="sekundaer" id="f-abbrechen">Abbrechen</button>' : ''}
      <div id="f-meldung" class="meldung"></div>
    </section>
    <section class="karte">
      <h2>Gespeichert bei ${esc(q.kurz)}</h2>
      <div class="liste">${eintraegeListe(q, bestaetigung?.id)}</div>
    </section>`;
  eingabeInfo();
}

function zeitraum() {
  if (form.modus === 'monat') {
    const von = `${form.monat}-01`;
    let bis = letzterTag(form.monat);
    if (form.monat === heute().slice(0, 7)) bis = heute();
    return { von, bis };
  }
  return { von: form.vonDatum, bis: form.bisDatum };
}

function tarifVorschlag() {
  const kwh = zahl(form.wert);
  if (!(kwh > 0)) return null;
  const tar = C.tarifAm(state.tarife, 'auswaerts', C.toDay(zeitraum().von));
  return tar ? Math.round(kwh * tar.arbeitspreisCent) / 100 : null;
}

function eingabeInfo() {
  const el = document.getElementById('f-info');
  if (!el) return;
  const q = quelle(form.quelleId);
  if (q.art === 'zaehlerstand') {
    const vorher = [{ datum: q.startDatum, wert: Number(q.startStand) || 0, start: true },
      ...eintraegeVon(q.id).filter((e) => e.id !== form.editId)]
      .filter((e) => e.datum < form.datum)
      .sort((x, y) => (x.datum < y.datum ? 1 : -1))[0];
    if (!vorher) { el.innerHTML = ''; return; }
    const w = zahl(form.wert);
    let txt = `Vorheriger Stand: <b>${f2.format(vorher.wert)} kWh</b> am ${datumDe(vorher.datum)}${vorher.start ? ' (Start)' : ''}`;
    if (!Number.isNaN(w)) {
      const delta = w - vorher.wert;
      const tage = C.toDay(form.datum) - C.toDay(vorher.datum);
      txt += `<br>Verbrauch seitdem: <b>${f1.format(delta)} kWh</b>${tage > 0 ? ` (Ø ${f1.format(delta / tage)} kWh/Tag)` : ''}`;
      if (delta < 0) txt += '<br><span class="warn">Der Stand ist kleiner als vorher – Tippfehler?</span>';
    }
    el.innerHTML = txt;
  } else {
    const { von, bis } = zeitraum();
    let txt = `Zeitraum: ${datumDe(von)} – ${datumDe(bis)}`;
    if (q.mitBetrag) {
      const v = tarifVorschlag();
      const inp = document.getElementById('f-betrag');
      if (inp) inp.placeholder = v != null ? f2.format(v) : '';
      if (v != null) txt += `<br>Nach Tarif wären es ca. <b>${eur.format(v)}</b> – trag ein, was du wirklich bezahlt hast.`;
    }
    el.innerHTML = txt;
  }
}

async function eingabeSpeichern() {
  const q = quelle(form.quelleId);
  const meld = document.getElementById('f-meldung');
  const w = zahl(form.wert);
  if (Number.isNaN(w)) { meld.textContent = 'Bitte einen Wert eintragen.'; meld.className = 'meldung fehler'; return; }
  let e;
  if (q.art === 'zaehlerstand') {
    if (!form.datum) return;
    e = { quelleId: q.id, datum: form.datum, wert: w, notiz: form.notiz.trim() };
    const gleich = state.eintraege.find((x) => x.quelleId === q.id && x.datum === form.datum && x.id !== form.editId);
    if (gleich && !confirm(`Für den ${datumDe(form.datum)} gibt es schon einen Stand (${f2.format(gleich.wert)}). Ersetzen?`)) return;
    if (gleich) state.eintraege = state.eintraege.filter((x) => x !== gleich);
  } else {
    const { von, bis } = zeitraum();
    if (!von || !bis || bis < von) { meld.textContent = 'Bitte einen gültigen Zeitraum wählen.'; meld.className = 'meldung fehler'; return; }
    e = { quelleId: q.id, vonDatum: von, datum: bis, wert: w, notiz: form.notiz.trim() };
    if (q.mitBetrag) {
      const b = zahl(form.betrag);
      e.betragEuro = Number.isNaN(b) ? tarifVorschlag() : b;
    }
    // Gleicher Monat bzw. gleicher Zeitraum schon vorhanden? -> ersetzen statt doppelt
    const gleich = state.eintraege.find((x) => x.quelleId === q.id && x.id !== form.editId && x.vonDatum === von
      && (form.modus === 'monat' ? x.datum.slice(0, 7) === von.slice(0, 7) : x.datum === bis));
    if (gleich) {
      const was = form.modus === 'monat' ? monatDe(form.monat) : `${datumDe(von)} – ${datumDe(bis)}`;
      if (!confirm(`Für ${was} gibt es schon einen Eintrag (${f2.format(gleich.wert)} kWh). Ersetzen?`)) return;
      state.eintraege = state.eintraege.filter((x) => x !== gleich);
    }
  }
  const warEdit = !!form.editId;
  const id = form.editId || neueId();
  if (warEdit) {
    const i = state.eintraege.findIndex((x) => x.id === form.editId);
    if (i >= 0) state.eintraege[i] = { ...e, id };
  } else {
    state.eintraege.push({ ...e, id });
  }
  await sichern();
  let text = `${q.kurz}: ${f2.format(e.wert)} kWh – ${eintragTitel(q, e)}`;
  if (e.betragEuro != null) text += ` – ${eur.format(e.betragEuro)}`;
  form = neuesForm(q.id);
  viewEingabe({ id, titel: warEdit ? 'Änderung gespeichert' : 'Gespeichert', text });
  window.scrollTo(0, 0);
}

// ---------- Verlauf ----------
function viewVerlauf() {
  const M = modell();
  const Q = M.q[verlaufQuelle];
  const q = Q.quelle;
  const chips = state.quellen.map((x) => `<button class="chip ${x.id === verlaufQuelle ? 'an' : ''}" data-verlauf="${x.id}">${esc(x.kurz)}</button>`).join('');
  const ms = C.monate(Q).slice(-15);
  const max = Math.max(1, ...ms.map((m) => m.kwh));
  const balken = ms.length ? ms.map((m) => `
      <div class="b-zeile">
        <span class="b-monat">${monatKurz(m.monat)}</span>
        <span class="b-spur"><span class="b-wert ${m.verteilt ? 'verteilt' : ''} ${m.voll ? '' : 'teil'}" style="width:${Math.max(1, (m.kwh / max) * 100)}%"></span></span>
        <span class="b-zahl">${f0.format(m.kwh)}</span>
      </div>`).join('') : '<p class="leer">Noch keine Monatswerte.</p>';
  const legende = ms.some((m) => m.verteilt || !m.voll)
    ? `<p class="hinweis">${ms.some((m) => m.verteilt) ? '<span class="punkt verteilt"></span> nach Jahreszeit verteilt (Ablesungen liegen weit auseinander) ' : ''}${ms.some((m) => !m.voll) ? '<span class="punkt teil"></span> Monat nicht vollständig' : ''}</p>` : '';

  const liste = eintraegeListe(q);

  const start = q.art === 'zaehlerstand' ? `<p class="klein">Gezählt seit ${datumDe(q.startDatum)} mit Startstand ${f2.format(Number(q.startStand) || 0)} kWh</p>` : '';

  $view.innerHTML = `
    <div class="chips oben">${chips}</div>
    <section class="karte"><h2>Monatsverbrauch ${esc(q.kurz)} (kWh)</h2>${balken}${legende}</section>
    <section class="karte"><h2>Einträge</h2>${start}<div class="liste">${liste}</div></section>`;
}

function eintragTitel(q, e) {
  if (q.art === 'zaehlerstand') return datumDe(e.datum);
  return e.vonDatum && e.vonDatum.slice(8) === '01' && e.vonDatum.slice(0, 7) === e.datum.slice(0, 7)
    ? monatDe(e.vonDatum.slice(0, 7)) + (e.datum === letzterTag(e.datum.slice(0, 7)) ? '' : ` (bis ${datumDe(e.datum).slice(0, 6)})`)
    : `${datumDe(e.vonDatum)} – ${datumDe(e.datum)}`;
}

// Liste aller Einträge einer Quelle, neueste zuerst; "neuId" wird hervorgehoben.
function eintraegeListe(q, neuId = null) {
  const es = eintraegeVon(q.id).sort((x, y) => (x.datum < y.datum ? 1 : x.datum > y.datum ? -1 : 0));
  if (!es.length) return '<p class="leer">Noch keine Einträge.</p>';
  return es.map((e, i) => {
    let neben = '';
    if (q.art === 'zaehlerstand') {
      const vor = es[i + 1] || { datum: q.startDatum, wert: Number(q.startStand) || 0 };
      neben = `+${f1.format(e.wert - vor.wert)} kWh seit ${datumDe(vor.datum)}`;
    } else if (e.betragEuro != null) {
      neben = `${eur.format(e.betragEuro)}${e.wert > 0 ? ` · ${f1.format((e.betragEuro / e.wert) * 100)} ct/kWh` : ''}`;
    }
    return eintragZeile(e, eintragTitel(q, e), `${f2.format(e.wert)} kWh`, neben, e.id === neuId);
  }).join('');
}

function eintragZeile(e, titel, haupt, neben, neu = false) {
  return `<div class="eintrag ${neu ? 'neu' : ''}">
    <div class="e-text"><div class="e-titel">${esc(titel)}${neu ? ' <span class="badge">neu</span>' : ''}</div><div class="e-haupt">${esc(haupt)}</div>
    ${neben ? `<div class="e-neben">${esc(neben)}</div>` : ''}${e.notiz ? `<div class="e-notiz">${esc(e.notiz)}</div>` : ''}</div>
    <div class="e-knoepfe"><button data-edit="${e.id}">Ändern</button><button class="loeschen" data-del="${e.id}">Löschen</button></div>
  </div>`;
}

function bearbeiten(id) {
  const e = state.eintraege.find((x) => x.id === id);
  if (!e) return;
  const q = quelle(e.quelleId);
  form = neuesForm(e.quelleId);
  form.editId = id;
  form.wert = zahlFeld(e.wert);
  form.notiz = e.notiz || '';
  if (q.art === 'zaehlerstand') form.datum = e.datum;
  else {
    const istMonat = e.vonDatum?.slice(8) === '01' && e.vonDatum.slice(0, 7) === e.datum.slice(0, 7);
    form.modus = istMonat ? 'monat' : 'frei';
    form.monat = e.datum.slice(0, 7);
    form.vonDatum = e.vonDatum || e.datum;
    form.bisDatum = e.datum;
    form.betrag = zahlFeld(e.betragEuro);
  }
  zeige('eingabe');
}

// ---------- Einstellungen ----------
function viewEinstellungen() {
  const E = state.einstellungen;
  const zaehler = state.quellen.filter((q) => q.art === 'zaehlerstand').map((q) => `
    <div class="zwei">
      <label>${esc(q.kurz)} – gezählt seit<input type="date" data-q="${q.id}" data-feld="startDatum" value="${q.startDatum}"></label>
      <label>Startstand (kWh)<input inputmode="decimal" data-q="${q.id}" data-feld="startStand" data-zahl value="${zahlFeld(q.startStand)}"></label>
    </div>`).join('');

  const tarifBlock = (bereich, titel, grundFeld, grundLabel) => {
    const ts = state.tarife.filter((t) => t.bereich === bereich).sort((x, y) => (x.gueltigAb < y.gueltigAb ? -1 : 1));
    return `<h3>${titel}</h3>` + ts.map((t) => `
      <div class="tarif">
        <div class="zwei">
          <label>Anbieter<input data-t="${t.id}" data-feld="anbieter" value="${esc(t.anbieter)}"></label>
          <label>gültig ab<input type="date" data-t="${t.id}" data-feld="gueltigAb" value="${t.gueltigAb}"></label>
        </div>
        <div class="zwei">
          <label>Arbeitspreis (ct/kWh)<input inputmode="decimal" data-t="${t.id}" data-feld="arbeitspreisCent" data-zahl value="${zahlFeld(t.arbeitspreisCent)}"></label>
          <label>${grundLabel}<input inputmode="decimal" data-t="${t.id}" data-feld="${grundFeld}" data-zahl value="${zahlFeld(t[grundFeld])}"></label>
        </div>
        <button class="link loeschen" data-tdel="${t.id}">Tarif löschen</button>
      </div>`).join('') + `<button class="sekundaer" data-tneu="${bereich}">+ Tarif hinzufügen</button>`;
  };

  $view.innerHTML = `
    <section class="karte">
      <h2>Abrechnung E.ON</h2>
      <div class="zwei">
        <label>Abrechnungsjahr beginnt<input type="date" data-e="abrechnungStart" value="${E.abrechnungStart}"></label>
        <label>Erster Abschlag am<input type="date" data-e="ersterAbschlag" value="${E.ersterAbschlag}"></label>
      </div>
      <div class="zwei">
        <label>Abschlag (€/Monat)<input inputmode="decimal" data-e="abschlagEuro" data-zahl value="${zahlFeld(E.abschlagEuro)}"></label>
      </div>
    </section>
    <section class="karte">
      <h2>Einspeisung EWE NETZ</h2>
      <div class="zwei">
        <label>Vergütung netto (ct/kWh)<input inputmode="decimal" data-w="verguetungNettoCent" data-zahl value="${zahlFeld(state.ewe.verguetungNettoCent)}"></label>
        <label>MwSt dazu?<select data-w="mwst"><option value="1" ${state.ewe.mwst ? 'selected' : ''}>ja, + 19 %</option><option value="0" ${state.ewe.mwst ? '' : 'selected'}>nein</option></select></label>
      </div>
      <div class="zwei">
        <label>Abrechnung von<input type="date" data-w="abrechnungStart" value="${state.ewe.abrechnungStart}"></label>
        <label>bis<input type="date" data-w="abrechnungEnde" value="${state.ewe.abrechnungEnde}"></label>
      </div>
      <div class="zwei">
        <label>Abschlag (€/Monat)<input inputmode="decimal" data-w="abschlagEuro" data-zahl value="${zahlFeld(state.ewe.abschlagEuro)}"></label>
        <label>Erster Abschlag<input type="date" data-w="ersterAbschlag" value="${state.ewe.ersterAbschlag}"></label>
      </div>
      <label>Letzter Abschlag<input type="date" data-w="letzterAbschlag" value="${state.ewe.letzterAbschlag}"></label>
      <p class="klein">Nach jeder EWE-Abrechnung hier Zeitraum und neuen Abschlag eintragen.</p>
    </section>
    <section class="karte">
      <h2>Tarife</h2>
      ${tarifBlock('haus', 'Strom zu Hause', 'grundpreisJahr', 'Grundpreis (€/Jahr)')}
      ${tarifBlock('auswaerts', 'Laden unterwegs', 'grundpreisMonat', 'Grundgebühr (€/Monat)')}
    </section>
    <section class="karte">
      <h2>Zähler – Startwerte</h2>
      ${zaehler}
    </section>
    <section class="karte">
      <h2>Daten sichern</h2>
      <p class="klein">Die Daten liegen nur auf diesem iPhone. Sichere sie ab und zu als Datei (z. B. in „Dateien" oder per AirDrop auf den Mac).</p>
      <button class="primaer" id="export-json">Sicherung exportieren (JSON)</button>
      <button class="sekundaer" id="export-csv">Einträge als Tabelle (CSV)</button>
      <label class="sekundaer datei">Sicherung importieren<input type="file" id="import" accept=".json,application/json"></label>
      <button class="link loeschen" id="alles-loeschen">Alle Daten löschen</button>
      <div id="s-meldung" class="meldung"></div>
    </section>
    <p class="fuss">Strom-Tagebuch · Version ${VERSION} · ${state.eintraege.length} Einträge</p>`;
}

async function einstellungAendern(el) {
  let v = el.value;
  if (el.hasAttribute('data-zahl')) { v = zahl(v); if (Number.isNaN(v)) v = 0; }
  if (el.dataset.w) state.ewe[el.dataset.w] = el.dataset.w === 'mwst' ? el.value === '1' : v;
  else if (el.dataset.e) state.einstellungen[el.dataset.e] = v;
  else if (el.dataset.q) { const q = quelle(el.dataset.q); if (q && v !== '') q[el.dataset.feld] = v; }
  else if (el.dataset.t) { const t = state.tarife.find((x) => x.id === el.dataset.t); if (t && v !== '') t[el.dataset.feld] = v; }
  await sichern();
}

async function teilenOderLaden(dateiname, inhalt, typ) {
  const blob = new Blob([inhalt], { type: typ });
  const file = new File([blob], dateiname, { type: typ });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: dateiname });
      return;
    }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = dateiname;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function csv() {
  const z = (v) => (v == null || v === '' ? '' : String(v).replace('.', ','));
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const zeilen = ['Quelle;von;Datum;kWh;Euro;Notiz'];
  const sortiert = [...state.eintraege].sort((a, b) => (a.quelleId + a.datum < b.quelleId + b.datum ? -1 : 1));
  for (const e of sortiert) zeilen.push([q(quelle(e.quelleId)?.name || e.quelleId), e.vonDatum || '', e.datum, z(e.wert), z(e.betragEuro), q(e.notiz)].join(';'));
  return '﻿' + zeilen.join('\n');
}

async function importieren(file) {
  const m = document.getElementById('s-meldung');
  try {
    const d = JSON.parse(await file.text());
    if (!Array.isArray(d.quellen) || !Array.isArray(d.eintraege) || !Array.isArray(d.tarife) || !d.einstellungen) throw new Error('Format');
    if (!confirm(`Sicherung mit ${d.eintraege.length} Einträgen laden? Die aktuellen Daten auf dem iPhone werden ersetzt.`)) return;
    state = migrieren(d);
    await sichern();
    viewEinstellungen();
    const m2 = document.getElementById('s-meldung');
    m2.textContent = `Importiert: ${d.eintraege.length} Einträge ✓`; m2.className = 'meldung ok';
  } catch {
    m.textContent = 'Die Datei konnte nicht gelesen werden.'; m.className = 'meldung fehler';
  }
}

// ---------- Navigation & Ereignisse ----------
const TITEL = { uebersicht: 'Übersicht', eingabe: 'Eingabe', verlauf: 'Verlauf', einstellungen: 'Einstellungen' };

function zeige(neu) {
  tab = neu;
  $titel.textContent = TITEL[tab];
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('aktiv', b.dataset.tab === tab));
  ({ uebersicht: viewUebersicht, eingabe: viewEingabe, verlauf: viewVerlauf, einstellungen: viewEinstellungen })[tab]();
  window.scrollTo(0, 0);
}

document.querySelector('.tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-tab]');
  if (b) zeige(b.dataset.tab);
});

$view.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button');
  if (!t) return;
  if (t.dataset.gotoVerlauf) { verlaufQuelle = t.dataset.gotoVerlauf; zeige('verlauf'); return; }
  if (t.dataset.quelle) { form = neuesForm(t.dataset.quelle); viewEingabe(); return; }
  if (t.dataset.modus) { form.modus = t.dataset.modus; viewEingabe(); return; }
  if (t.id === 'f-speichern') { await eingabeSpeichern(); return; }
  if (t.id === 'f-abbrechen') { form = neuesForm(form.quelleId); viewEingabe(); return; }
  if (t.dataset.verlauf) { verlaufQuelle = t.dataset.verlauf; viewVerlauf(); return; }
  if (t.dataset.edit) { bearbeiten(t.dataset.edit); return; }
  if (t.dataset.del) {
    const e = state.eintraege.find((x) => x.id === t.dataset.del);
    if (e && confirm(`Eintrag vom ${datumDe(e.datum)} (${f2.format(e.wert)} kWh) löschen?`)) {
      state.eintraege = state.eintraege.filter((x) => x.id !== e.id);
      await sichern();
      if (tab === 'eingabe') { if (form?.editId === e.id) form = neuesForm(form.quelleId); viewEingabe(); } else viewVerlauf();
    }
    return;
  }
  if (t.dataset.tneu) {
    const b = t.dataset.tneu;
    const neu = { id: neueId(), bereich: b, anbieter: b === 'haus' ? 'E.ON' : 'EnBW', name: '', gueltigAb: heute(), arbeitspreisCent: 0 };
    neu[b === 'haus' ? 'grundpreisJahr' : 'grundpreisMonat'] = 0;
    state.tarife.push(neu); await sichern(); viewEinstellungen(); return;
  }
  if (t.dataset.tdel) {
    if (confirm('Diesen Tarif löschen?')) { state.tarife = state.tarife.filter((x) => x.id !== t.dataset.tdel); await sichern(); viewEinstellungen(); }
    return;
  }
  if (t.id === 'export-json') { await teilenOderLaden(`strom-tagebuch-${heute()}.json`, JSON.stringify(state, null, 2), 'application/json'); return; }
  if (t.id === 'export-csv') { await teilenOderLaden(`strom-tagebuch-${heute()}.csv`, csv(), 'text/csv'); return; }
  if (t.id === 'alles-loeschen') {
    if (confirm('Wirklich ALLE Einträge und Einstellungen löschen?') && confirm('Sicher? Das lässt sich nicht rückgängig machen – vorher exportieren!')) {
      state = defaultState(); await sichern(); viewEinstellungen();
    }
  }
});

$view.addEventListener('input', (ev) => {
  const el = ev.target;
  if (tab !== 'eingabe' || !form) return;
  const map = { 'f-datum': 'datum', 'f-wert': 'wert', 'f-monat': 'monat', 'f-von': 'vonDatum', 'f-bis': 'bisDatum', 'f-betrag': 'betrag', 'f-notiz': 'notiz' };
  if (map[el.id]) { form[map[el.id]] = el.value; eingabeInfo(); }
});

$view.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (el.id === 'import' && el.files?.[0]) { await importieren(el.files[0]); el.value = ''; return; }
  if (tab === 'einstellungen' && (el.dataset.e || el.dataset.w || el.dataset.q || el.dataset.t)) await einstellungAendern(el);
});

$view.addEventListener('keydown', async (ev) => {
  if (ev.key === 'Enter' && tab === 'eingabe' && ev.target.tagName === 'INPUT') { ev.preventDefault(); await eingabeSpeichern(); }
});

// ---------- Start ----------
(async function start() {
  state = migrieren((await laden()) || defaultState());
  dauerhaftAnfragen();
  zeige('uebersicht');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
