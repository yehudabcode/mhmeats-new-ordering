// ══════════════════════════════════════════════════════════════════
// MH MEATS NEW ORDERING TOOL — PRODUCTION RULES
// Pure calculations only (no screen code). Used by the staff app and by
// the automated tests. Rules copied from the live tool (app.html,
// PRODUCT_VERSION 32) on 29 Sep 2026.
//
// Data shapes used everywhere:
//   catalogue = { customers: [ {id,name,short,color,bulk,products:[
//                   {id,cat,name,unit,mult,flavoured,plu,staffOnly,produceAs,active}]} ] }
//   dayOrders = { customerId: { productId: {qty, note} } }
//   cat is one of: beef | poultry | flavoured | chef-beef | chef-chicken | chef-lamb
// ══════════════════════════════════════════════════════════════════
(function (root) {
  'use strict';

  // ── Butcher multipliers: packs ordered → individual units for butcher ──
  const POULTRY_MULT = {
    'WHOLE ROASTER': 1, 'ROASTER IN 1/4': 1, 'ROASTER IN 1/8': 1,
    'ROASTER IN 1/4 SHNITZELED': 1, 'ROASTER IN 1/8 SHNITZELED': 1, 'ROASTER IN 1/8 TOP MINCED': 1,
    'CARCASS-1-PACK': 1, 'CARCASS-2-PACK': 2, '5-PACK CARCASSES': 5, 'DOUBLE SOUP PACK': 2,
    'BREAST QUARTERS': 1, 'LEG QUARTERS 2-PACK': 2, 'LEG QUARTERS 4-PACK': 4, 'LEG QUARTERS 6-PACK': 6,
    'LEG QUARTERS IN 1/8 2-PACK': 2, 'LEG QUARTERS IN 1/8 4-PACK': 4, 'CHICKEN DRUMSTICKS': 6,
    'ROASTER THIGHS 2-PACK': 2, 'ROASTER THIGHS 4-PACK': 4, 'CAPONS (BONED THIGHS)': 6,
    'CHICKEN WINGS 6-PACK': 6, '12-PACK CHICKEN WINGS': 12, 'CHICKEN NECKS (8-PACK)': 8,
    'CHICKEN FILLETS': 2, 'CUBED CHICKEN': 0.5, 'CHICKEN GOUJONS': 12,
    'SHNITZELS-2-PACK': 2, 'SHNITZELS-6-PACK': 6, 'SHNITZELS-10-PACK': 10, 'CHICKEN PARGIOT': 4,
    'MINCED CHICKEN': 0.5, 'CHICKEN STIRFRY': 0.5, 'CHICKEN STIR FRY': 0.5, 'PLAIN CHICKEN STIR FRY': 0.5,
    'CHICKEN LIVER': 1, 'PUPICKS': 1, 'WHITE TURKEY ROLL': 1, 'DARK TURKEY ROLL': 1,
    'CHICKEN SHWARMA': 1, 'CHICKEN DIPPERS': 1,
    'SHNITZELS': 1, 'CARCASSES': 1, 'WINGS': 1, 'BREADED SHNITZELS': 1, 'CHICKEN LEGS': 1, 'CHICKEN LEGS IN 1/8': 1,
  };

  // ── Butcher poultry groups. Each line: [display name, [product names], unit] ──
  const POULTRY_GROUPS = [
    { cat: 'FULL BIRDS', roasterTotal: true, lines: [
      ['WHOLE ROASTER', ['WHOLE ROASTER']],
      ['ROASTER IN 1/4', ['ROASTER IN 1/4']],
      ['ROASTER IN 1/8', ['ROASTER IN 1/8']],
      ['ROASTER IN 1/4 SHNITZELED', ['ROASTER IN 1/4 SHNITZELED']],
      ['ROASTER IN 1/8 SHNITZELED', ['ROASTER IN 1/8 SHNITZELED']],
      ['ROASTER IN 1/8 TOP MINCED', ['ROASTER IN 1/8 TOP MINCED']],
    ]},
    { cat: 'BOTTOM QUARTERS', lines: [
      ['LEG QUARTERS (ALL PACKS)', ['LEG QUARTERS 2-PACK', 'LEG QUARTERS 4-PACK', 'LEG QUARTERS 6-PACK', 'CHICKEN LEGS']],
      ['LEG QUARTERS IN 1/8 (ALL PACKS)', ['LEG QUARTERS IN 1/8 2-PACK', 'LEG QUARTERS IN 1/8 4-PACK', 'CHICKEN LEGS IN 1/8']],
      ['CAPONS (BONED THIGHS)', ['CAPONS (BONED THIGHS)']],
      ['CHICKEN PARGIOT', ['CHICKEN PARGIOT']],
      ['CHICKEN DRUMSTICKS', ['CHICKEN DRUMSTICKS']],
      ['ROASTER THIGHS 2-PACK', ['ROASTER THIGHS 2-PACK']],
      ['ROASTER THIGHS 4-PACK', ['ROASTER THIGHS 4-PACK']],
    ]},
    { cat: 'CROWNS', lines: [
      ['BREAST QUARTERS', ['BREAST QUARTERS']],
      ['CUBED CHICKEN', ['CUBED CHICKEN'], 'KG'],
      ['CHICKEN STIRFRY', ['CHICKEN STIRFRY', 'CHICKEN STIR FRY', 'PLAIN CHICKEN STIR FRY'], 'KG'],
      ['MINCED CHICKEN', ['MINCED CHICKEN'], 'KG'],
      ['CHICKEN GOUJONS', ['CHICKEN GOUJONS']],
      ['CHICKEN FILLETS', ['CHICKEN FILLETS']],
      ['CARCASS (ALL PACKS)', ['CARCASS-1-PACK', 'CARCASS-2-PACK', '5-PACK CARCASSES', 'CARCASSES']],
      ['SOUP PACKS (ALL)', ['DOUBLE SOUP PACK']],
      ['SHNITZELS (TOTAL INDIVIDUAL)', ['SHNITZELS-2-PACK', 'SHNITZELS-6-PACK', 'SHNITZELS-10-PACK', 'SHNITZELS', 'BREADED SHNITZELS']],
      ['WINGS (ALL PACKS)', ['CHICKEN WINGS 6-PACK', '12-PACK CHICKEN WINGS', 'WINGS']],
      ['CHICKEN NECKS (8-PACK)', ['CHICKEN NECKS (8-PACK)']],
      ['CHICKEN LIVER', ['CHICKEN LIVER']],
      ['PUPICKS', ['PUPICKS']],
    ]},
    { cat: 'TURKEY', lines: [
      ['BONELESS TURKEY THIGHS', ['BONELESS TURKEY THIGHS'], 'KG'],
      ['TURKEY DRUMSTICKS', ['TURKEY DRUMSTICKS'], 'KG'],
      ['TURKEY WINGS', ['TURKEY WINGS'], 'KG'],
      ['TURKEY FILLETS', ['TURKEY FILLETS'], 'KG'],
      ['WHITE TURKEY ROLL', ['WHITE TURKEY ROLL'], 'UNITS'],
      ['DARK TURKEY ROLL', ['DARK TURKEY ROLL'], 'UNITS'],
    ]},
  ];

  // ── Butcher beef categories — full list always printed, zeros included ──
  const BEEF_CATEGORIES = [
    { cat: 'MINCE', items: [['MINCED BEEF', 'KG'], ['MINCED STEAK', 'KG']] },
    { cat: 'CHUCK', items: [
      ['GOULASH BEEF CUBES', 'KG', '70/30 fat content'],
      ['POT ROAST', 'UNITS', '1.5-1.8KG, netted, max diameter 12cm'],
      ['ROLLED TOP RIB JOINT', 'UNITS', '1.5-1.8KG, netted, max diameter 12cm'],
      ['DOUBLE TOP RIB', 'UNITS'], ['WHOLE TOP RIB', 'UNITS', '400-500G'], ['CUBED TOP RIB', 'KG'],
      ['TOP RIB ON BONE', 'KG'], ['FALSHE FILLET MIGNON', 'UNITS'], ['DENVER STEAKS', 'UNITS', 'Marbled, 2cm thick'],
      ['BRAISING STEAK', 'UNITS', '1.5cm thick'], ['CHUCK EYE STEAKS', 'UNITS', '1.5cm thick'], ['OYSTER STEAK', 'UNITS'],
      ['FRENCH ROAST', 'UNITS', 'Marbled, 1.2-1.6KG'], ['PULLED BEEF JOINT', 'UNITS'],
    ]},
    { cat: 'BRISKET', items: [
      ['ROLLED BRISKET JOINT', 'UNITS', '1.5-1.8KG, max diameter 12cm, netted'],
      ['FLAT BRISKET JOINT', 'UNITS', '1.5-1.8KG'], ['FLAT PICKLED JOINT', 'UNITS', '1.5-1.8KG'],
      ['FLAT PICKLED BRISKET', 'UNITS'],
      ['ROLLED PICKLED BRISKET', 'UNITS', '1.5-1.8KG, netted, max diameter 12cm'],
      ['PICKLED BEEF ROLL', 'UNITS', '1.5-1.8KG'],
    ]},
    { cat: 'RIBEYE', items: [
      ['MINUTE STEAKS', 'UNITS', 'Thin, pre-freeze 2-3 hours'], ['RIB-EYE STEAKS', 'UNITS', '2cm thick'],
      ['COTE DE BOUEF', 'UNITS', 'Marbled, chine each steak'], ['LONDON BROIL 500G', 'UNITS'], ['LONDON BROIL 1KG', 'UNITS'],
      ['RIBEYE JOINT', 'UNITS', 'Tied with string only'], ['RIB STRIPS', 'UNITS'],
    ]},
    { cat: 'BLADE', items: [['BLADE STEAKS', 'UNITS', '1.5cm thick'], ['BLADE JOINT', 'UNITS'], ['FLAT IRON STEAK', 'UNITS']] },
    { cat: 'BOLA', items: [
      ['BOLA STEAKS', 'UNITS', 'Remove gristle'], ['BOLA JOINT', 'UNITS', 'No silver skin 1.5-1.8KG'], ['BEEF STIRFRY', 'KG'],
      ['FAIRY STEAKS', 'UNITS', '1.5cm thick'], ['LEAN SANDWICH STEAKS', 'UNITS', 'No gristle'],
    ]},
    { cat: 'RIB PLATE', items: [
      ['BEEF RIBLETS (FLANKEN)', 'UNITS', '2cm thick'], ['RIB ON BONE', 'UNITS', '12cm long, 3cm thick'],
      ['3-BONE SHORT RIB', 'UNITS', '12cm long, 3cm thick'], ['BONELESS SHORT RIB', 'UNITS'],
      ['BEEF SPARE RIBS', 'UNITS', '12cm long, 3cm thick'],
    ]},
    { cat: 'SHIN', items: [['WHOLE SHIN', 'UNITS', '600-700G'], ['SLICED SHIN', 'KG', '2-3cm thick'], ['CUBED SHIN', 'KG']] },
    { cat: 'FLANK', items: [
      ['FLANK', 'UNITS', '400-500G'], ['PRIME CHOLENT MEAT', 'UNITS'], ['CUBED CHOLENT BEEF', 'KG', '70/30 fat content'],
      ['CHOLENT PACK', 'KG'], ['GALLA BONES', 'UNITS'], ['MARROW BONES', 'UNITS'], ['MEAT BONES', 'KG'],
    ]},
    { cat: 'DELI', items: [
      ['BACK OF RIB', 'KG'], ['CHUCK', 'KG'], ['DELI FLANK', 'KG'], ['FLAT BRISKET FAT ON', 'KG'], ['FLAT BRISKET', 'KG'],
      ['BRISKET FLAP FAT ON', 'KG'], ['BOLA', 'KG', 'No silver skin 1.5-1.8KG'], ['RIBEYE', 'UNITS'],
      ['MINCED STEAK 90/10', 'KG'], ['MINCED BEEF 70/30', 'KG'], ['ECONOMY MINCE 60/40', 'KG'],
      ['PICKLED TONGUES', 'UNITS'], ['FRESH TONGUES', 'UNITS'],
    ]},
  ];

  // Products that are produced/packed under a different name.
  // THIN SLICED GRILLING STEAK (KS Meats) is cut and packed as MINUTE STEAKS.
  const PRODUCE_AS = { 'THIN SLICED GRILLING STEAK': 'MINUTE STEAKS' };

  // ── Helpers ─────────────────────────────────────────────────────────
  const round1 = n => Math.round(n * 10) / 10;
  const isBeef = p => p.cat === 'beef';
  const isFlav = p => !!p.flavoured || p.cat === 'flavoured';
  const produceName = p => (p.produceAs || PRODUCE_AS[p.name] || p.name);
  const byName = (a, b) => a.name.localeCompare(b.name);

  function lineOf(dayOrders, custId, prodId) {
    const c = dayOrders && dayOrders[custId];
    const l = c && c[prodId];
    return l && Number(l.qty) > 0 ? l : null;
  }

  // Every ordered line for one customer, in catalogue order.
  function customerLines(cust, dayOrders) {
    const out = [];
    const known = new Set();
    cust.products.forEach(p => {
      known.add(p.id);
      const l = lineOf(dayOrders, cust.id, p.id);
      if (l) out.push({ product: p, qty: Number(l.qty), note: l.note || '' });
    });
    // Lines whose product was removed from the catalogue after ordering — never hide them.
    const c = (dayOrders && dayOrders[cust.id]) || {};
    Object.keys(c).forEach(pid => {
      if (known.has(pid) || !(Number(c[pid].qty) > 0)) return;
      out.push({ product: { id: pid, cat: 'poultry', name: '⚠ UNKNOWN PRODUCT (' + pid + ')', unit: '' }, qty: Number(c[pid].qty), note: c[pid].note || '', orphan: true });
    });
    return out;
  }

  // ── CHEF SHEET: flavoured products from ALL customers + everything MH Meats Chef orders ──
  // (The old tool's chef sheet depended on customer order and could drop lines,
  //  e.g. caterers' flavoured Cumberland sausages. This rule is order-independent.)
  const isChefLine = p => !isBeef(p) && (isFlav(p) || String(p.cat).indexOf('chef-') === 0);
  function chef(catalogue, dayOrders) {
    const totals = {};
    catalogue.customers.forEach(cust => {
      customerLines(cust, dayOrders).forEach(l => {
        if (!isChefLine(l.product)) return;
        const k = l.product.name;
        if (!totals[k]) totals[k] = { name: k, qty: 0, sources: [] };
        totals[k].qty += l.qty;
        totals[k].sources.push({ id: cust.id, short: cust.short, qty: l.qty, note: l.note });
      });
    });
    return Object.values(totals).sort(byName);
  }

  // ── BUTCHER LISTS ─────────────────────────────────────────────────
  function butcher(catalogue, dayOrders) {
    const retail = catalogue.customers.filter(c => !c.bulk);
    // name → butcher amount (packs × multiplier), retail customers only
    const poultryAmt = {}, beefAmt = {}, plainPoultry = new Set();
    retail.forEach(cust => customerLines(cust, dayOrders).forEach(l => {
      const p = l.product;
      if (isBeef(p)) {
        const n = produceName(p);
        beefAmt[n] = (beefAmt[n] || 0) + l.qty * (p.mult !== undefined && p.mult !== null && p.mult !== '' ? Number(p.mult) : 1);
      } else if (!isFlav(p)) {
        const mult = POULTRY_MULT[p.name] !== undefined ? POULTRY_MULT[p.name] : 1;
        poultryAmt[p.name] = (poultryAmt[p.name] || 0) + l.qty * mult;
        if (p.cat === 'poultry') plainPoultry.add(p.name);
      }
    }));

    const poultry = POULTRY_GROUPS.map(g => {
      const items = g.lines.map(([name, names, unit]) => ({
        name, unit: unit || 'UNITS', qty: round1(names.reduce((a, n) => a + (poultryAmt[n] || 0), 0)),
      })).filter(i => i.qty > 0);
      const res = { cat: g.cat, items };
      if (g.roasterTotal) res.roasters = round1(items.reduce((a, b) => a + b.qty, 0));
      return res;
    }).filter(g => g.items.length);

    const beef = BEEF_CATEGORIES.map(g => ({
      cat: g.cat,
      items: g.items.map(([name, unit, desc]) => ({ name, unit, desc: desc || '', qty: round1(beefAmt[name] || 0) })),
    }));

    // Beef products ordered by retail customers that are not on the butcher list — never drop them.
    const listed = new Set(BEEF_CATEGORIES.flatMap(g => g.items.map(i => i[0])));
    const other = Object.keys(beefAmt).filter(n => !listed.has(n) && beefAmt[n] > 0).sort()
      .map(n => ({ name: n, unit: '', desc: 'not on standard butcher list', qty: round1(beefAmt[n]) }));
    if (other.length) beef.push({ cat: 'OTHER BEEF', items: other });

    // Plain poultry products (not chef-prepared) that feed no butcher group — list them too.
    const grouped = new Set(POULTRY_GROUPS.flatMap(g => g.lines.flatMap(l => l[1])));
    const otherP = [...plainPoultry].filter(n => !grouped.has(n) && poultryAmt[n] > 0).sort()
      .map(n => ({ name: n, unit: 'UNITS', qty: round1(poultryAmt[n]) }));

    const bulk = catalogue.customers.filter(c => c.bulk).map(cust => {
      const lines = customerLines(cust, dayOrders);
      const bp = lines.filter(l => !isBeef(l.product) && !isFlav(l.product))
        .map(l => ({ name: l.product.name, unit: 'UNITS', qty: l.qty, note: l.note }));
      const bb = lines.filter(l => isBeef(l.product))
        .map(l => ({ name: produceName(l.product), orderedAs: l.product.produceAs ? l.product.name : '', unit: l.product.unit || 'UNITS', qty: l.qty, note: l.note }));
      return { cust, poultry: bp, beef: bb };
    }).filter(b => b.poultry.length || b.beef.length);

    return { poultry, otherPoultry: otherP, beef, bulk };
  }

  // ── PACKER LISTS: raw pack quantities ─────────────────────────────
  function packer(catalogue, dayOrders) {
    const poultryT = {}, beefT = {};
    catalogue.customers.filter(c => !c.bulk).forEach(cust => customerLines(cust, dayOrders).forEach(l => {
      const p = l.product;
      if (isBeef(p)) {
        const k = produceName(p);
        if (!beefT[k]) beefT[k] = { name: k, qty: 0, unit: p.unit || 'UNITS', sources: [] };
        beefT[k].qty += l.qty;
        beefT[k].sources.push({ id: cust.id, short: cust.short, qty: l.qty, note: l.note });
      } else if (!isFlav(p)) {   // Flavoured products excluded from packer — Chef sheet only
        const k = p.name;
        if (!poultryT[k]) poultryT[k] = { name: k, qty: 0, sources: [] };
        poultryT[k].qty += l.qty;
        poultryT[k].sources.push({ id: cust.id, short: cust.short, qty: l.qty, note: l.note });
      }
    }));
    const bulk = catalogue.customers.filter(c => c.bulk).map(cust => {
      const lines = customerLines(cust, dayOrders);
      const m = l => ({ name: isBeef(l.product) ? produceName(l.product) : l.product.name, orderedAs: l.product.produceAs ? l.product.name : '', unit: l.product.unit || 'UNITS', qty: l.qty, note: l.note });
      return {
        cust,
        poultry: lines.filter(l => !isBeef(l.product) && !isFlav(l.product)).map(m),
        flavoured: lines.filter(l => !isBeef(l.product) && isFlav(l.product)).map(m),
        beef: lines.filter(l => isBeef(l.product)).map(m),
      };
    }).filter(b => b.poultry.length || b.flavoured.length || b.beef.length);
    return { poultry: Object.values(poultryT).sort(byName), beef: Object.values(beefT).sort(byName), bulk };
  }

  // ── DISPATCH: every customer, everything they ordered ─────────────
  function dispatch(catalogue, dayOrders) {
    return catalogue.customers.map(cust => {
      const lines = customerLines(cust, dayOrders);
      const m = l => ({ name: l.product.name, producedAs: l.product.produceAs || '', unit: isBeef(l.product) ? (l.product.unit || 'UNITS') : '', qty: l.qty, note: l.note, orphan: !!l.orphan });
      return {
        cust,
        poultry: lines.filter(l => !isBeef(l.product) && !isFlav(l.product)).map(m),
        flavoured: lines.filter(l => !isBeef(l.product) && isFlav(l.product)).map(m),
        beef: lines.filter(l => isBeef(l.product)).map(m),
      };
    }).filter(d => d.poultry.length || d.flavoured.length || d.beef.length);
  }

  function countLines(catalogue, dayOrders, custId) {
    const c = (dayOrders && dayOrders[custId]) || {};
    return Object.keys(c).filter(k => Number(c[k].qty) > 0).length;
  }

  const api = { POULTRY_MULT, POULTRY_GROUPS, BEEF_CATEGORIES, PRODUCE_AS, customerLines, chef, butcher, packer, dispatch, countLines, produceName, isBeef, isFlav };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MHRules = api;
})(this);
