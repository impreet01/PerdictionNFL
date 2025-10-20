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
