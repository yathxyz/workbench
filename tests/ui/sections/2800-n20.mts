import { check, state, until } from '../shared.mts';
import { acpEvs, acpIdle, acpSay, acpView, stubSection } from '../acp.mts';

/* The requested schema of a form elicitation, as N20 fills it. */
interface AcpFormSchema { required?: string[]; properties?: Record<string, AcpFormProp> }
interface AcpFormProp { type: string; minimum?: number; minLength?: number }

await stubSection('N20', async () => {
  const { AP, AID } = state;
  const id = AID, s0 = (await acpView(AP, id))!.seq;
  await acpSay(AP, id, 'form');
  const ev = await until(() => acpEvs(AP, id, 'elicitation', s0)[0], 15000);
  await until(async () => (await acpView(AP, id))!.form === 1, 5000);
  const st = await AP.evaluate(({ id, schema }: { id: string; schema: AcpFormSchema }) => {
    const box = window.__canvas.live[id].body.querySelector('.ag-form'), acc = [...box.querySelectorAll('.acts button')].find(b => b.textContent === 'Accept');
    const need = new Set(schema.required || []), want: Record<string, unknown> = {}, kinds: string[] = [], fire = (e: Element) => e.dispatchEvent(new Event('input', { bubbles: true }));
    const fill = (k: string, p: AcpFormProp) => {
      const row = box.querySelector(`.fld[data-key="${CSS.escape(k)}"]`), sel = row.querySelector('select'), many = row.querySelectorAll('.multi input'), inp = row.querySelector('input, textarea');
      if (sel) { const o = [...sel.options].find(o => o.value !== ''); sel.value = o.value; want[k] = o.value; kinds.push('enum'); fire(sel); }
      else if (many.length) { many[0].checked = true; want[k] = [many[0].value]; kinds.push('multi'); fire(many[0]); }
      else if (inp?.type === 'checkbox') { inp.checked = true; want[k] = true; kinds.push('boolean'); fire(inp); }
      else if (inp?.type === 'number') { const v = p.minimum ?? 1; inp.value = String(v); want[k] = v; kinds.push(p.type); fire(inp); }
      else if (inp) { const v = 'n20'.padEnd(p.minLength || 0, 'x'); inp.value = v; want[k] = v; kinds.push('string'); fire(inp); }
    };
    const props = Object.entries(schema.properties || {});
    for (const [k, p] of props) if (!need.has(k)) fill(k, p);
    // A required enum has no empty option, so it starts on its first choice (30 §1.4); clear it to see Accept wait.
    for (const k of need) { const sel = box.querySelector(`.fld[data-key="${CSS.escape(k)}"] select`); if (sel) { sel.selectedIndex = -1; fire(sel); } }
    const before = acc.disabled;
    for (const [k, p] of props) if (need.has(k)) fill(k, p);
    const after = acc.disabled; acc.click();
    return { before, after, want, kinds, need: [...need] };
  }, { id, schema: ev?.request?.requestedSchema || {} });
  const res = await until(() => acpEvs(AP, id, 'elicitation_resolved', s0)[0], 10000);
  const sorted = (o: Record<string, unknown> | null | undefined) => JSON.stringify(Object.keys(o || {}).sort().map(k => [k, o![k]]));
  // The hub journals the response it forwards verbatim (10 §11.3 `elicitation`), so the journal shows what the stub got.
  check('N20: a form shows enum, integer, boolean and multi-select fields; Accept stays off until the required field is filled; the stub gets the exact content',
    ['enum', 'integer', 'boolean', 'multi'].every(k => st.kinds.includes(k)) && st.need.length > 0 && st.before === true && st.after === false && res?.response?.action === 'accept' && sorted(res.response.content) === sorted(st.want), JSON.stringify({ st, res }));
  await acpIdle(AP, id);
});
