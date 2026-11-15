import printCss from "../styles/print-export.css?raw";

/** The exported HTML with the print page style added. The print window gets this; the HTML download does not
 *  (print-export.css says why). The style goes last in <head> so it wins over the site's own rules. */
export function withPrintStyle(html: string): string {
  const style = `<style id="print-export">${printCss}</style>`;
  return html.includes("</head>") ? html.replace("</head>", () => `${style}\n</head>`) : `${style}${html}`;
}
