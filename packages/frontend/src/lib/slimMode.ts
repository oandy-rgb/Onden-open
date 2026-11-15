/** Past this many nodes the boot STAYS slim: the full-body bootstrap (which
 *  pulls every markdown into the heap) is skipped, so the LRU keeps evicting
 *  and only ~HYDRATED_BODY_CAP bodies are ever resident. Below it the full
 *  fetch lands as before (no behaviour change for normal workspaces). The slim
 *  bootstrap's own node count is the gate — no extra roundtrip. The local
 *  database applies the same threshold when it paints a cached workspace, so a
 *  downloaded offline copy never puts every body in memory. */
export const SLIM_MODE_NODE_THRESHOLD = 2000;
