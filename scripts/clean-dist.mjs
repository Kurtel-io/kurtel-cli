import { rmSync } from "node:fs";
// Fixed package-relative build output: prevent removed commands surviving upgrades.
rmSync(new URL("../dist/", import.meta.url), { recursive: true, force: true });
