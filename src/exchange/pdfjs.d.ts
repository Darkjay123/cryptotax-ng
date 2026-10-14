declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export interface TextItem { str?: string; transform?: number[]; width?: number; height?: number }
  export interface PdfPage { getTextContent(): Promise<{ items: TextItem[] }>; }
  export interface PdfDoc { numPages: number; getPage(n: number): Promise<PdfPage>; destroy(): Promise<void> | void; }
  export function getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDoc> };
}
