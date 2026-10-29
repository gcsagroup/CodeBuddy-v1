declare module 'virtual:codebuddy-dsh-document/pdf' {
  const definition: { factory: (require: (id: string) => unknown) => { PdfBody: import('react').ComponentType<import('./dshDocumentRenderer').DshPdfProps> } };
  export default definition;
}
declare module 'virtual:codebuddy-dsh-document/excel' {
  const definition: { factory: (require: (id: string) => unknown) => { ExcelBody: import('react').ComponentType<import('./dshDocumentRenderer').DshExcelProps> } };
  export default definition;
}
declare module 'virtual:codebuddy-dsh-document/zoom' {
  const definition: { factory: (require: (id: string) => unknown) => {
    ZoomViewport: import('react').ComponentType<Record<string, unknown>>;
    zoomSurfaceClass: string;
    locales: Record<'pdf' | 'excel', Record<'zh' | 'en', Record<string, string>>>;
  } };
  export default definition;
}
