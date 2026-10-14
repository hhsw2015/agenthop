/**
 * render.mts — the notebook's render CLI (tern-adoption line ③ B4). Thin shell over render-core.ts: writes the
 * deterministic review-ledger digest markdown to stdout. "Tern 出渲染,我们出数据" — the Tern notebook cell invokes this.
 * Run: tsx notebook/render.mts   (env AH_HOME overrides ~). Two runs ⇒ byte-identical stdout (see render.selftest.mts).
 */
import { homedir } from "node:os";
import { renderDigestReport } from "./render-core.js";

process.stdout.write(renderDigestReport(process.env.AH_HOME || homedir()));
