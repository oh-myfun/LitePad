/// <reference types="vite/client" />

declare module "*?inline" {
  const content: string;
  export default content;
}

// B452 · plantuml-encoder 是 CJS 且不带 .d.ts（encode = deflate + 自定义 base64）。
declare module "plantuml-encoder" {
  export function encode(text: string): string;
  export function decode(text: string): string;
}

// B455 · wavedrom 同样是 CJS 且不发类型，而这里只用得上两个出口。
declare module "wavedrom" {
  interface WaveDrom {
    /**
     * 把一份 WaveJSON 画进 outputElement（会先清空它）。
     * 第一个参会被拼进 DOM id（`waves_<i>` / `lanes_<i>` / `svgcontent_<i>`）⇒ 每块要给唯一的一发。
     *
     * 收口用得上 shadow root（库只走 `appendChild` / `innerHTML`，两形都吃）⇒ 类型给到这里。
     */
    renderWaveElement(
      index: number,
      source: object,
      outputElement: Element | ShadowRoot,
      waveSkin: object,
      notFirstSignal?: boolean,
      notFirstAssign?: boolean,
    ): void;
    /** 那张皮肤表（svg 模板 + 一整段 CSS），调用时原样传回去。 */
    waveSkin: Record<string, unknown>;
  }
  const wavedrom: WaveDrom;
  export default wavedrom;
}
