// render-form.mjs — turn a schema field-spec from extract-schemas.mjs into DOM.
//
// Loaded by the editor frontend. One pure function per Zod kind. No framework,
// no diffing — when the schema changes, blow away the form and rebuild.

export function renderForm(fields, values, onChange) {
  const root = document.createElement('div');
  for (const f of fields) {
    root.appendChild(renderField(f, values[f.name], v => {
      values[f.name] = v;
      onChange(values);
    }));
  }
  return root;
}

function renderField(f, value, onChange) {
  const wrap  = el('div', 'field');
  const label = el('label', 'field-label' + (f.required ? ' required' : ''));
  label.textContent = humanize(f.name);
  const input = el('div', 'field-input');

  if (f.kind === 'string')  input.appendChild(textInput(value, onChange));
  else if (f.kind === 'number')  input.appendChild(numberInput(value, onChange));
  else if (f.kind === 'boolean') input.appendChild(boolInput(value, onChange));
  else if (f.kind === 'date')    input.appendChild(dateInput(value, onChange));
  else if (f.kind === 'enum')    input.appendChild(enumInput(f.options, value ?? f.default, onChange));
  else if (f.kind === 'array')   input.appendChild(arrayInput(f.of, value ?? [], onChange));
  else if (f.kind === 'object')  input.appendChild(objectInput(f.fields, value ?? {}, onChange));
  else                            input.appendChild(textInput(value, onChange));

  wrap.append(label, input);
  return wrap;
}

// ── primitives ──────────────────────────────────────────────────────────────

const textInput = (v, on) => {
  const i = el('input'); i.type = 'text'; i.value = v ?? '';
  i.oninput = () => on(i.value);
  return i;
};

const numberInput = (v, on) => {
  const i = el('input'); i.type = 'number'; i.value = v ?? '';
  i.oninput = () => on(i.value === '' ? undefined : Number(i.value));
  return i;
};

const boolInput = (v, on) => {
  const i = el('input'); i.type = 'checkbox'; i.checked = !!v;
  i.onchange = () => on(i.checked);
  return i;
};

const dateInput = (v, on) => {
  const i = el('input'); i.type = 'date';
  i.value = typeof v === 'string' ? v.slice(0, 10) : '';
  i.oninput = () => on(i.value);
  return i;
};

const enumInput = (opts, v, on) => {
  const s = el('select');
  for (const o of opts) {
    const option = el('option'); option.value = option.textContent = o;
    if (o === v) option.selected = true;
    s.appendChild(option);
  }
  s.onchange = () => on(s.value);
  return s;
};

// ── array (chip input for string arrays; nested forms otherwise) ────────────

function arrayInput(of, value, onChange) {
  if (!Array.isArray(value)) value = [];  // defensive: backend may pass empty string for missing arrays
  const wrap = el('div', 'tag-list');
  const redraw = () => {
    wrap.innerHTML = '';
    value.forEach((item, i) => {
      if (of.kind === 'string') {
        const tag = el('span', 'tag');
        tag.textContent = item;
        const x = el('span', 'x'); x.textContent = '×';
        x.onclick = () => { value.splice(i, 1); onChange([...value]); redraw(); };
        tag.appendChild(x);
        wrap.appendChild(tag);
      } else {
        // Nested object/array — render a sub-form panel
        const panel = el('div', 'sub-panel');
        panel.appendChild(renderField({ ...of, name: `${i}` }, item, v => {
          value[i] = v; onChange([...value]);
        }));
        wrap.appendChild(panel);
      }
    });
    if (of.kind === 'string') {
      const add = el('input', 'tag-input'); add.placeholder = '+ tag';
      add.onkeydown = e => {
        if (e.key === 'Enter' && add.value) {
          value.push(add.value); onChange([...value]); add.value = ''; redraw();
        }
      };
      wrap.appendChild(add);
    }
  };
  redraw();
  return wrap;
}

// ── nested object ───────────────────────────────────────────────────────────

function objectInput(fields, value, onChange) {
  const wrap = el('fieldset', 'sub-panel');
  for (const f of fields) {
    wrap.appendChild(renderField(f, value[f.name], v => {
      value[f.name] = v; onChange({ ...value });
    }));
  }
  return wrap;
}

// ── utils ───────────────────────────────────────────────────────────────────

const el = (tag, className) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
};

const humanize = name => name
  .replace(/[_-]/g, ' ')
  .replace(/\b\w/g, c => c.toUpperCase());
