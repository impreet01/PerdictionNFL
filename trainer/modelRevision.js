export function canReuseModel(prevRevision, curRevision, schemaInfo) {
  const prev = prevRevision ? String(prevRevision) : null;
  const cur = curRevision ? String(curRevision) : null;
  if (prev && cur && prev === cur) return true;

  if (!schemaInfo) return false;
  if (typeof schemaInfo === "string") {
    const hash = String(schemaInfo).trim();
    if (!hash) return false;
    return true;
  }

  if (typeof schemaInfo === "object") {
    const previousHash = schemaInfo.previous ?? schemaInfo.prev ?? schemaInfo.source ?? null;
    const expectedHash = schemaInfo.expected ?? schemaInfo.current ?? schemaInfo.target ?? null;
    if (!previousHash) return false;
    if (expectedHash && expectedHash !== previousHash) {
      return false;
    }
    return true;
  }

  return false;
}

export function mapModelRevision(payload, { fromRevision, toRevision, filePath } = {}) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  if (!fromRevision || fromRevision === toRevision) {
    return payload;
  }
  const fromLabel = String(fromRevision);
  const toLabel = String(toRevision);
  if (fromLabel === toLabel) {
    return payload;
  }
  console.log(
    `[promote] Attempting model schema shim from ${fromLabel} → ${toLabel} for ${filePath ?? "payload"}.`
  );
  return payload;
}
