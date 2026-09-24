/* Pure, shared dashboard arithmetic. Draws are the default weighting unit. */
(function (root) {
  'use strict';
  const valid = r => r && /^\d{4}-\d{2}-\d{2}$/.test(r.draw) && Number.isInteger(r.pairs) && r.pairs > 0
    && ['modelHits','controlHits'].every(k => Number.isInteger(r[k]) && r[k] >= 0 && r[k] <= r.pairs)
    && Number.isFinite(r.diffMain) && Math.abs(r.diffMain) <= 5*r.pairs;
  function select(rows, {game, model, from, through}) {
    return (Array.isArray(rows) ? rows : []).filter(r => valid(r) && r.lottery === game && r.model === model
      && r.draw >= from && r.draw <= through).sort((a,b) => a.draw.localeCompare(b.draw));
  }
  function summarize(rows, weighting='draw') {
    const groups = new Map();
    for (const r of rows.filter(valid)) {
      const d = groups.get(r.draw) || {draw:r.draw,pairs:0,modelHits:0,controlHits:0,diffMain:0};
      for (const k of ['pairs','modelHits','controlHits','diffMain']) d[k] += r[k];
      groups.set(r.draw,d);
    }
    const draws = [...groups.values()].sort((a,b) => a.draw.localeCompare(b.draw));
    const pairs = draws.reduce((s,d) => s+d.pairs,0);
    const rate = key => !pairs ? null : weighting === 'line'
      ? draws.reduce((s,d) => s+d[key],0)/pairs
      : draws.reduce((s,d) => s+d[key]/d.pairs,0)/draws.length;
    const modelRate=rate('modelHits'),controlRate=rate('controlHits');
    return {draws:draws.length,pairs,modelRate,controlRate,
      difference: pairs ? modelRate-controlRate : null,mainDifference:rate('diffMain'),
      modelHits:draws.reduce((s,d)=>s+d.modelHits,0),controlHits:draws.reduce((s,d)=>s+d.controlHits,0),
      first:draws[0]?.draw || null,last:draws.at(-1)?.draw || null,series:draws};
  }
  const api={select,summarize};
  if (typeof module !== 'undefined' && module.exports) module.exports=api;
  else root.PPAIStats=api;
})(globalThis);
