function parseDate(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateOptions(date: Date): Intl.DateTimeFormatOptions {
  const options: Intl.DateTimeFormatOptions = {
    month: "numeric",
    day: "numeric",
  };
  if (date.getFullYear() !== new Date().getFullYear()) options.year = "numeric";
  return options;
}

export function formatDate(value?: string, fallback = "发布时间未知") {
  const date = parseDate(value);
  return date ? date.toLocaleDateString("zh-CN", dateOptions(date)) : fallback;
}

export function formatDateTime(value?: string) {
  const date = parseDate(value);
  if (!date) return "";
  return date.toLocaleString("zh-CN", {
    ...dateOptions(date),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

export function formatSavedDate(value?: string) {
  const date = parseDate(value);
  return date ? "收藏于 " + formatDate(value) : "收藏时间未知";
}
