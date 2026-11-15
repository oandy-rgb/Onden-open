// electron-builder 的 extraResources 一律略過名為 node_modules 的資料夾，而後端的執行環境就是一個 node_modules。
// 所以後端（stage/server，含 node_modules）在打包後由這裡原樣複製到 resources/server。
const { cpSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  const resources = context.electronPlatformName === "darwin"
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : join(context.appOutDir, "resources");
  cpSync(join(__dirname, "..", "stage", "server"), join(resources, "server"), { recursive: true, verbatimSymlinks: true });
};
