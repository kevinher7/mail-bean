#!/usr/bin/env node
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { env: { type: "string" } },
});

if (values.env) process.loadEnvFile(values.env);

await import("../dist/index.js");
