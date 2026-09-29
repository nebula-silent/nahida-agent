// 8.7.9 补：qrcode 包浏览器入口的类型声明。
// qrcode 不随包发 .d.ts（tsconfig.renderer 命中 TS7016）。按项目主进程的既有约定
// （music-smoke-entry / weixin-login 用 `require("qrcode") + 类型断言` 规避）不新增
// @types/qrcode 依赖，这里只声明渲染层实际用到的 API，够用不过度。
declare module "qrcode/lib/browser" {
  interface QRCodeToDataURLOptions {
    type?: "image/png" | "image/jpeg" | "image/webp";
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    margin?: number;
    width?: number;
    scale?: number;
  }
  const qrcode: {
    toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
  };
  export default qrcode;
}