import path from "node:path";

process.env.CORRAL_CONFIG = path.resolve(import.meta.dirname, "fixtures/environments.json");
