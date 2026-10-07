/**
 * @typedef {{ columns: string[], rows: { line: number, cells: string[] }[], error: string }} MemoryJsonlTable
 * @typedef {{ content: string, table?: MemoryJsonlTable }} MemoryFileContent
 */

/**
 * Prepares both memory-file presentations exclusively in the data worker.
 * @param {string} path
 * @param {string} content
 * @returns {MemoryFileContent}
 */
export function prepareMemoryFile(path, content) {
  return {
    content: formatMemoryFileContent(path, content),
    ...(/\.jsonl$/i.test(path) ? { table: parseMemoryJsonl(content) } : {}),
  };
}

/**
 * Adapts a bounded memory file to a display payload in the data worker.
 * @param {string} content
 * @returns {MemoryJsonlTable}
 */
function parseMemoryJsonl(content) {
  /** @type {Map<string, number>} */
  const fields = new Map();
  /** @type {{ line: number, values: Map<number, string>, value?: string }[]} */
  const records = [];
  let hasValues = false;
  const lines = content.split(/\r\n|\n|\r/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    /** @type {unknown} */
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return { columns: [], rows: [], error: `Invalid JSON on line ${index + 1}. Use Raw to inspect the file.` };
    }
    /** @type {{ line: number, values: Map<number, string> }} */
    const record = { line: index + 1, values: new Map() };
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [field, cell] of Object.entries(value)) {
        const column = fields.get(field) ?? fields.size;
        fields.set(field, column);
        record.values.set(column, typeof cell === 'string' ? cell : JSON.stringify(cell));
      }
      records.push(record);
    } else {
      hasValues = true;
      records.push({ ...record, value: typeof value === 'string' ? value : JSON.stringify(value) });
    }
  }
  return {
    columns: [...fields.keys(), ...(hasValues ? ['Value (non-object)'] : [])],
    rows: records.map((record) => ({
      line: record.line,
      cells: [
        ...Array.from({ length: fields.size }, (_, index) => record.values.get(index) ?? ''),
        ...(hasValues ? [record.value ?? ''] : []),
      ],
    })),
    error: '',
  };
}

/**
 * Pretty-prints JSON and valid JSONL records without changing the underlying file.
 * @param {string} path
 * @param {string} content
 */
function formatMemoryFileContent(path, content) {
  /** @param {string} text */
  const prettyPrint = (text) => {
    const trailingWhitespace = text.match(/\s*$/u)?.[0] ?? '';
    const json = text.slice(0, text.length - trailingWhitespace.length);
    try {
      return `${JSON.stringify(JSON.parse(json), null, 2) ?? text}${trailingWhitespace}`;
    } catch {
      return text;
    }
  };
  if (/\.json$/i.test(path)) return prettyPrint(content);
  if (!/\.jsonl$/i.test(path)) return content;
  return content.split(/(\r\n|\n|\r)/).map((part, index) => {
    if (index % 2 === 1 || part.trim() === '') return part;
    return prettyPrint(part);
  }).join('');
}
