import seedrandom from "seedrandom";

process.env.TZ = "UTC";
seedrandom("42", { global: true });
jest.setTimeout(180000);
