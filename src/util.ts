const classifyBy = function <T, S>(
  items: Iterable<T>,
  classifyFunc: (item: T) => S,
): Map<S, T[]> {
  const map: Map<S, T[]> = new Map();

  for (const item of items) {
    const _class = classifyFunc(item);

    const arr = map.get(_class);
    if (arr) {
      arr.push(item);
    } else {
      map.set(_class, [item]);
    }
  }

  return map;
};

// deno-lint-ignore no-control-regex
const ansiControlSeqRegExp = /\x1b\[\d+(;\d+)?m/g;
const printableLength = function (text: string) {
  return text.replace(ansiControlSeqRegExp, '').length;
};
const padToLength = function (text: string, length: number) {
  return (text + ' '.repeat(length)).slice(0, length);
};
const renderTable = function (cells: string[][]): string {
  const columns = cells
    .map((row) => row.length)
    .reduce((prev, cur) => prev > cur ? prev : cur, 0);
  // Add spaces so that all rows have the same number of columns
  const tableCells = cells
    .map((row) => new Array(columns).fill('').map((v, i) => row[i] ?? v));
  const cellLengths = tableCells.map((row) =>
    row.map((cel) => printableLength(cel))
  );
  const maxCellWidths = new Array(columns)
    .fill(0)
    .map((_, i) =>
      cellLengths.reduce((prev, row) => prev > row[i] ? prev : row[i], 0)
    );

  return tableCells
    .map((row) =>
      row
        .map((cell, i) => padToLength(cell, maxCellWidths[i]))
        .join(' ')
    )
    .join('\n');
};

export { classifyBy, renderTable };
