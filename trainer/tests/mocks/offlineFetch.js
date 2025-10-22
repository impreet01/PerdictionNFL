globalThis.fetch = async () => ({
  ok: false,
  status: 404,
  statusText: "Not Found",
  text: async () => "Not Found"
});
