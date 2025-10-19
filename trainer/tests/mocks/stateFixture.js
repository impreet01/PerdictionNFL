// Inject deterministic season coverage for raw bootstrap tests
if (!globalThis.__STATE_BUILDER_FIXTURE__) {
  globalThis.__STATE_BUILDER_FIXTURE__ = {};
}
Object.assign(globalThis.__STATE_BUILDER_FIXTURE__, {
  1999: [1, 2],
  2000: [1, 2]
});
