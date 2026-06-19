import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataPath = path.resolve(here, "..", "src", "demoData.json");
const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));

if (!data.title || !data.tagline) {
  throw new Error("demo data requires title and tagline");
}

if (!Array.isArray(data.scenes) || data.scenes.length < 3) {
  throw new Error("demo data requires at least three scenes");
}

for (const [index, scene] of data.scenes.entries()) {
  for (const field of ["kicker", "headline", "body"]) {
    if (typeof scene[field] !== "string" || scene[field].trim() === "") {
      throw new Error(`scene ${index} missing ${field}`);
    }
  }
  if (!Array.isArray(scene.bullets) || scene.bullets.length === 0) {
    throw new Error(`scene ${index} requires bullets`);
  }
}

console.log(`validated ${data.scenes.length} demo scenes`);
