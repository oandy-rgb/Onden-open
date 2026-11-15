#!/usr/bin/env node
// 重新產生各套件 AGENTS.md 裡從允許清單來的表（npm run agents:tables）。手寫的部分不動。
import { writeAll } from "./agentsTablesLib.mjs";

const changed = writeAll();
console.log(changed.length ? `已更新：${changed.join("、")}` : "AGENTS.md 的產生區塊已是最新");
