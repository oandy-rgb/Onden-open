import { replay, withRule, RULES } from "./variantEngine.js";
import { loadRaw, buildRealSeqLog } from "./realSeq.js";
import { loadTrace } from "../traces.js";
import { buildOpLog } from "./variantEngine.js";
for (const f of ["ff-raw.json", "git-makefile-raw.json", "node_nodecc-raw.json"]) {
  const r = loadRaw(f);
  for (const [n, rule] of Object.entries(RULES)) {
    let out=''; try { out = withRule(rule, () => replay(buildRealSeqLog(r.txns))); } catch (e) { console.log(f,n,'錯誤',(e as Error).message); continue; }
    let i = 0; while (i < out.length && out[i] === r.endContent[i]) i++;
    console.log(f, n, out === r.endContent, i);
  }
}
const c = loadTrace("clownschool");
for (const [n, rule] of Object.entries(RULES)) { const out = withRule(rule, () => replay(buildOpLog(c.history))); console.log("clownschool", n, out === c.history.endContent); }
