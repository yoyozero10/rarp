import { startRuntime } from "../../dist/runtime/server.js";
await startRuntime(process.argv[2], {
  file: process.execPath,
  args: [
    "-e",
    "require('node:fs').writeFileSync('partial.txt','preserved'); setInterval(()=>{},1000)",
  ],
});
process.send?.("ready");
