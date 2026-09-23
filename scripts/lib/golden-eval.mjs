const outcomeFields = ["authorized", "toolStatus", "jiraCreated"];
const toolStatuses = new Set(["not_called", "ok", "bounded_error"]);

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== [...expected].sort()[index])) {
    throw new TypeError(`${label} has missing or unknown fields.`);
  }
}

function outcome(value, label) {
  exactKeys(value, outcomeFields, label);
  if (typeof value.authorized !== "boolean") throw new TypeError(`${label}.authorized must be boolean.`);
  if (!toolStatuses.has(value.toolStatus)) throw new TypeError(`${label}.toolStatus is invalid.`);
  if (typeof value.jiraCreated !== "boolean") throw new TypeError(`${label}.jiraCreated must be boolean.`);
}

export function evaluateCase(row) {
  exactKeys(row, ["datasetVersion", "id", "observed", "assert"], "case");
  if (row.datasetVersion !== "container-v1") throw new TypeError("Unsupported dataset version.");
  if (typeof row.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.id)) {
    throw new TypeError("Case id is invalid.");
  }
  outcome(row.observed, "observed");
  outcome(row.assert, "assert");
  const failures = outcomeFields.filter((field) => row.observed[field] !== row.assert[field]);
  return { id: row.id, passed: failures.length === 0, failures };
}

export function evaluateCases(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new TypeError("Dataset must have cases.");
  const seen = new Set();
  return rows.map((row) => {
    const result = evaluateCase(row);
    if (seen.has(result.id)) throw new TypeError("Duplicate case id.");
    seen.add(result.id);
    return result;
  });
}
