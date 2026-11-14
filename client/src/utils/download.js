/** Saves text as a file in the browser (used for the CSV template and the error report). */
export function downloadText(fileName, text, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([`﻿${text}`], { type })); // BOM so Excel reads UTF-8 correctly
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
