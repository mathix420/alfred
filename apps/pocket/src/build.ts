import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { buildBrowser } from "./server";

const root = resolve(import.meta.dir, "..");
const web = resolve(root, "web");
const output = resolve(root, "dist");
await mkdir(output, { recursive: true });
await Bun.write(resolve(output, "app.js"), await buildBrowser(web));
for (const file of ["index.html", "styles.css", "assets"]) {
  await cp(resolve(web, file), resolve(output, file), { recursive: true });
}
console.log("Built pocket browser assets in apps/pocket/dist");
