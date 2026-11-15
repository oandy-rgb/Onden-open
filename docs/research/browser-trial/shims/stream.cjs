// stream 的替身：只讓匯出／備份用到的 Readable.from 在載入期不爆（真正串流在試用版不提供匯出 zip 時才會碰到）
class Readable { static from(x) { return new Readable(); } static fromWeb(x) { return x; } pipe() { throw new Error("stream is not available in the browser trial"); } }
class Transform {} class PassThrough {}
module.exports = { Readable, Transform, PassThrough, pipeline: async () => { throw new Error("stream.pipeline is not available in the browser trial"); } };
